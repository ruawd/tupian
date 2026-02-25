require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const crypto = require('crypto');
const { imageSize } = require('image-size');
const multer = require('multer');
const sharp = require('sharp');

const app = express();
const PORT = process.env.PORT || 3122;

// 管理密码（仅从环境变量读取，不硬编码）
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

// 支持的图片格式
const SUPPORTED_FORMATS = ['.webp', '.avif', '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.ico', '.svg'];
const SUPPORTED_FORMAT_SET = new Set(SUPPORTED_FORMATS);

// 图片缓存
let horizontalImages = [];
let verticalImages = [];

// 目录路径
const RI_PATH = path.join(__dirname, 'ri');
const H_PATH = path.join(RI_PATH, 'h');
const V_PATH = path.join(RI_PATH, 'v');
const INBOX_PATH = path.join(RI_PATH, 'inbox');
const THUMB_PATH = path.join(RI_PATH, 'thumb');
const THUMB_H_PATH = path.join(THUMB_PATH, 'h');
const THUMB_V_PATH = path.join(THUMB_PATH, 'v');
const HASH_INDEX_PATH = path.join(RI_PATH, '.hash-index.json');

// 缩略图生成去重缓存
const thumbInFlight = new Map();

// 高频管理接口限流
const manageRouteCooldown = new Map();

// 图片内容哈希索引（用于上传去重）
let imageHashIndex = new Map(); // hash -> relative path
let imagePathHashIndex = new Map(); // relative path -> hash
let imageHashIndexReady = false;
let imageHashIndexSyncNeeded = true;
let imageHashIndexBuilding = null;
let hashIndexPersistTimer = null;

// 配置 multer 存储
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, INBOX_PATH),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname);
        const name = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9_\-\u4e00-\u9fa5]/g, '');
        cb(null, `${name}_${Date.now()}${ext}`);
    }
});
const upload = multer({
    storage,
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        if (SUPPORTED_FORMAT_SET.has(ext)) {
            cb(null, true);
        } else {
            cb(new Error('不支持的图片格式'));
        }
    },
    limits: { fileSize: 50 * 1024 * 1024 } // 50MB 限制
});

app.use('/api', (req, res, next) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, x-admin-password');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(204);
    }
    next();
});

// 密码验证中间件
function requireAuth(req, res, next) {
    if (!ADMIN_PASSWORD) {
        return res.status(403).json({ success: false, message: '服务端未配置管理密码' });
    }
    const password = req.headers['x-admin-password'];
    if (!password || password !== ADMIN_PASSWORD) {
        return res.status(403).json({ success: false, message: '密码错误或未提供' });
    }
    next();
}


// 确保目录存在
function ensureDirectories() {
    [RI_PATH, H_PATH, V_PATH, INBOX_PATH, THUMB_PATH, THUMB_H_PATH, THUMB_V_PATH].forEach(dir => {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    });
}

// 扫描目录获取所有支持格式的图片
function scanImageDirectory(dirPath) {
    try {
        if (!fs.existsSync(dirPath)) return [];

        const files = fs.readdirSync(dirPath);
        return files.filter(file => {
            const ext = path.extname(file).toLowerCase();
            return SUPPORTED_FORMAT_SET.has(ext);
        });
    } catch (error) {
        console.error(`❌ 扫描目录失败 ${dirPath}:`, error.message);
        return [];
    }
}

function parseBoundedInt(value, fallback, min, max) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
}

const CLASSIFY_CONCURRENCY = parseBoundedInt(process.env.CLASSIFY_CONCURRENCY, 3, 1, 8);

function hashBufferSHA256(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

function markImageHashIndexDirty() {
    imageHashIndexSyncNeeded = true;
}

function normalizeRelativeImagePath(relativePath) {
    const normalized = String(relativePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
    return /^(h|v)\/.+/.test(normalized) ? normalized : '';
}

function resolveRelativeImagePath(relativePath) {
    const normalized = normalizeRelativeImagePath(relativePath);
    if (!normalized) return null;

    const slashAt = normalized.indexOf('/');
    const type = normalized.slice(0, slashAt);
    const subPath = normalized.slice(slashAt + 1);
    const baseDir = type === 'h' ? H_PATH : V_PATH;
    const absolutePath = path.resolve(baseDir, subPath);
    if (!absolutePath.startsWith(baseDir + path.sep)) {
        return null;
    }
    return absolutePath;
}

function toRelativeImagePath(filePath) {
    const absolutePath = path.resolve(filePath);
    if (absolutePath.startsWith(H_PATH + path.sep)) {
        return `h/${path.relative(H_PATH, absolutePath).split(path.sep).join('/')}`;
    }
    if (absolutePath.startsWith(V_PATH + path.sep)) {
        return `v/${path.relative(V_PATH, absolutePath).split(path.sep).join('/')}`;
    }
    return '';
}

function rebuildImageHashIndexFromPathMap() {
    const nextHashMap = new Map();
    for (const [relativePath, hash] of imagePathHashIndex.entries()) {
        if (!nextHashMap.has(hash)) {
            nextHashMap.set(hash, relativePath);
        }
    }
    imageHashIndex = nextHashMap;
}

function setImageHashIndexEntry(relativePath, hash) {
    const normalizedPath = normalizeRelativeImagePath(relativePath);
    if (!normalizedPath || !hash) return;
    imagePathHashIndex.set(normalizedPath, hash.toLowerCase());
    rebuildImageHashIndexFromPathMap();
}

function removeImageHashIndexEntryByRelativePath(relativePath) {
    const normalizedPath = normalizeRelativeImagePath(relativePath);
    if (!normalizedPath) return;
    if (imagePathHashIndex.delete(normalizedPath)) {
        rebuildImageHashIndexFromPathMap();
    }
}

function removeFileFromHashIndex(filePath) {
    if (!imageHashIndexReady) return;
    const relativePath = toRelativeImagePath(filePath);
    if (!relativePath) return;
    removeImageHashIndexEntryByRelativePath(relativePath);
    schedulePersistImageHashIndex();
}

async function persistImageHashIndex() {
    if (!imageHashIndexReady) return;
    const entries = Array.from(imagePathHashIndex.entries()).sort((a, b) => a[0].localeCompare(b[0]));
    const payload = {
        version: 1,
        updatedAt: new Date().toISOString(),
        entries
    };
    const tempPath = `${HASH_INDEX_PATH}.tmp`;
    await fsp.writeFile(tempPath, JSON.stringify(payload));
    await fsp.rename(tempPath, HASH_INDEX_PATH);
}

function schedulePersistImageHashIndex() {
    if (!imageHashIndexReady) return;
    if (hashIndexPersistTimer) {
        clearTimeout(hashIndexPersistTimer);
    }
    const timer = setTimeout(() => {
        hashIndexPersistTimer = null;
        persistImageHashIndex().catch(error => {
            console.error('❌ 保存去重索引失败:', error.message);
        });
    }, 500);
    hashIndexPersistTimer = timer;
    timer.unref?.();
}

async function loadImageHashIndexFromDisk() {
    if (!(await fileExists(HASH_INDEX_PATH))) return false;

    try {
        const raw = await fsp.readFile(HASH_INDEX_PATH, 'utf8');
        const parsed = JSON.parse(raw);
        const entries = Array.isArray(parsed?.entries) ? parsed.entries : null;
        if (!entries) return false;

        const nextPathMap = new Map();
        for (const item of entries) {
            if (!Array.isArray(item) || item.length !== 2) continue;
            const [relativePathRaw, hashRaw] = item;
            const relativePath = normalizeRelativeImagePath(relativePathRaw);
            const hash = String(hashRaw || '').toLowerCase();
            if (!relativePath) continue;
            if (!/^[a-f0-9]{64}$/.test(hash)) continue;
            if (!resolveRelativeImagePath(relativePath)) continue;
            nextPathMap.set(relativePath, hash);
        }

        imagePathHashIndex = nextPathMap;
        rebuildImageHashIndexFromPathMap();
        imageHashIndexReady = true;
        imageHashIndexSyncNeeded = true; // 启动后做一次轻量同步，修正外部变更
        return true;
    } catch (error) {
        console.error('❌ 读取去重索引失败，将重建:', error.message);
        return false;
    }
}

async function buildImageHashIndex() {
    const nextPathMap = new Map();
    for (const [type, dir] of [['h', H_PATH], ['v', V_PATH]]) {
        const files = scanImageDirectory(dir);
        for (const filename of files) {
            const filePath = path.join(dir, filename);
            try {
                const hash = hashBufferSHA256(await fsp.readFile(filePath));
                const relativePath = `${type}/${filename}`;
                nextPathMap.set(relativePath, hash);
            } catch (error) {
                console.error(`❌ 读取图片哈希失败 ${filePath}:`, error.message);
            }
        }
    }

    imagePathHashIndex = nextPathMap;
    rebuildImageHashIndexFromPathMap();
    imageHashIndexReady = true;
    imageHashIndexSyncNeeded = false;
    schedulePersistImageHashIndex();
}

async function syncImageHashIndexWithFilesystem() {
    const currentPaths = [];
    for (const [type, dir] of [['h', H_PATH], ['v', V_PATH]]) {
        const files = scanImageDirectory(dir);
        for (const filename of files) {
            currentPaths.push(`${type}/${filename}`);
        }
    }

    const currentPathSet = new Set(currentPaths);
    let changed = false;

    for (const relativePath of Array.from(imagePathHashIndex.keys())) {
        if (!currentPathSet.has(relativePath)) {
            imagePathHashIndex.delete(relativePath);
            changed = true;
        }
    }

    for (const relativePath of currentPathSet) {
        if (imagePathHashIndex.has(relativePath)) continue;
        const absolutePath = resolveRelativeImagePath(relativePath);
        if (!absolutePath) continue;
        try {
            const hash = hashBufferSHA256(await fsp.readFile(absolutePath));
            imagePathHashIndex.set(relativePath, hash);
            changed = true;
        } catch (error) {
            console.error(`❌ 增量同步哈希失败 ${absolutePath}:`, error.message);
        }
    }

    if (changed) {
        rebuildImageHashIndexFromPathMap();
        schedulePersistImageHashIndex();
    }

    imageHashIndexSyncNeeded = false;
}

async function runHashIndexTask(task) {
    if (imageHashIndexBuilding) {
        await imageHashIndexBuilding;
    }
    imageHashIndexBuilding = (async () => {
        try {
            await task();
        } finally {
            imageHashIndexBuilding = null;
        }
    })();
    await imageHashIndexBuilding;
}

async function ensureImageHashIndex() {
    if (!imageHashIndexReady) {
        await runHashIndexTask(async () => {
            if (imageHashIndexReady) return;
            const loaded = await loadImageHashIndexFromDisk();
            if (!loaded) {
                await buildImageHashIndex();
                console.log(`🔐 去重索引已重建: ${imageHashIndex.size} 条`);
            } else {
                console.log(`🔐 去重索引已加载: ${imageHashIndex.size} 条`);
            }
        });
    }

    if (imageHashIndexSyncNeeded) {
        await runHashIndexTask(async () => {
            if (!imageHashIndexSyncNeeded) return;
            await syncImageHashIndexWithFilesystem();
        });
    }
}

async function findDuplicatePathByHash(hash) {
    const duplicateRelativePath = imageHashIndex.get(hash);
    if (!duplicateRelativePath) return '';

    const duplicatePath = resolveRelativeImagePath(duplicateRelativePath);
    if (duplicatePath && await fileExists(duplicatePath)) {
        return duplicatePath;
    }

    // 索引有脏数据时懒清理
    removeImageHashIndexEntryByRelativePath(duplicateRelativePath);
    markImageHashIndexDirty();
    schedulePersistImageHashIndex();
    return '';
}

async function dedupeInboxFilesBySourceHash(filenames) {
    const seenHashSet = new Set();
    const uniqueFiles = [];
    let duplicated = 0;

    for (const name of filenames) {
        const safeName = path.basename(String(name || ''));
        if (!safeName) continue;

        const srcPath = path.join(INBOX_PATH, safeName);
        if (!(await fileExists(srcPath))) continue;

        try {
            const hash = hashBufferSHA256(await fsp.readFile(srcPath));
            if (seenHashSet.has(hash)) {
                await fsp.unlink(srcPath).catch(error => {
                    if (error.code !== 'ENOENT') throw error;
                });
                duplicated += 1;
                continue;
            }
            seenHashSet.add(hash);
            uniqueFiles.push(safeName);
        } catch (error) {
            console.error(`❌ 上传批次去重失败 ${safeName}:`, error.message);
            uniqueFiles.push(safeName);
        }
    }

    return { files: uniqueFiles, duplicated };
}

async function fileExists(filePath) {
    try {
        await fsp.access(filePath, fs.constants.F_OK);
        return true;
    } catch {
        return false;
    }
}

function resolveImagePathFromUrlPath(rawUrlPath) {
    if (typeof rawUrlPath !== 'string' || rawUrlPath.length === 0) {
        return null;
    }

    let decoded;
    try {
        decoded = decodeURIComponent(rawUrlPath);
    } catch {
        return null;
    }

    const match = decoded.match(/^\/ri\/(h|v)\/(.+)$/);
    if (!match) {
        return null;
    }

    const type = match[1];
    const relativeName = match[2].replace(/^[/\\]+/, '');
    if (!relativeName) {
        return null;
    }

    const baseDir = type === 'h' ? H_PATH : V_PATH;
    const filePath = path.resolve(baseDir, relativeName);
    if (!filePath.startsWith(baseDir + path.sep)) {
        return null;
    }

    const thumbDir = type === 'h' ? THUMB_H_PATH : THUMB_V_PATH;
    const thumbPath = path.join(thumbDir, `${path.basename(relativeName, path.extname(relativeName))}.webp`);
    return { type, relativeName, filePath, thumbPath };
}

function createCooldownMiddleware(routeKey, cooldownMs) {
    return (req, res, next) => {
        const rawIp = req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
        const clientIp = Array.isArray(rawIp) ? rawIp[0] : String(rawIp).split(',')[0].trim();
        const key = `${routeKey}:${clientIp}`;
        const now = Date.now();
        const lastAt = manageRouteCooldown.get(key) || 0;
        const delta = now - lastAt;

        if (delta < cooldownMs) {
            const waitSeconds = Math.ceil((cooldownMs - delta) / 1000);
            return res.status(429).json({ success: false, message: `请求过于频繁，请 ${waitSeconds} 秒后重试` });
        }

        manageRouteCooldown.set(key, now);
        next();
    };
}

// 初始化图片列表
function initImageLists() {
    horizontalImages = scanImageDirectory(H_PATH);
    verticalImages = scanImageDirectory(V_PATH);

    console.log(`📁 横屏图片: ${horizontalImages.length} 张 | 竖屏图片: ${verticalImages.length} 张`);
}

// 自动分类并压缩单个图片（转 WebP，最大 500KB）
async function classifyImage(filename, options = {}) {
    const { refreshList = true } = options;
    const safeFilename = path.basename(String(filename || ''));
    if (!safeFilename) return 'skipped';

    const srcPath = path.join(INBOX_PATH, safeFilename);

    try {
        // 检查文件是否存在
        if (!(await fileExists(srcPath))) return 'skipped';

        // 获取图片尺寸 (image-size v2 需要传入 buffer)
        const buffer = await fsp.readFile(srcPath);
        const dimensions = imageSize(buffer);
        const { width, height } = dimensions;
        if (!width || !height) {
            throw new Error('无法识别图片尺寸');
        }

        // 判断横屏还是竖屏
        const isHorizontal = width >= height;
        const destDir = isHorizontal ? H_PATH : V_PATH;

        // 压缩转 WebP，最大 500KB
        const MAX_SIZE = 500 * 1024; // 500KB
        let quality = 85;
        let usedQuality = quality;
        let outputBuffer;

        // 逐步降低画质直到文件小于 500KB
        while (quality >= 20) {
            usedQuality = quality;
            outputBuffer = await sharp(buffer)
                .webp({ quality })
                .toBuffer();

            if (outputBuffer.length <= MAX_SIZE) break;
            quality -= 10;
        }

        // 如果还是太大，缩小分辨率
        if (outputBuffer.length > MAX_SIZE) {
            const scale = Math.sqrt(MAX_SIZE / outputBuffer.length);
            const newWidth = Math.round(width * scale);
            outputBuffer = await sharp(buffer)
                .resize({ width: newWidth, withoutEnlargement: true })
                .webp({ quality: 30 })
                .toBuffer();
            usedQuality = 30;
        }

        // 去重：用压缩后内容计算哈希，与现有图库比对
        const outputHash = hashBufferSHA256(outputBuffer);
        await ensureImageHashIndex();
        const duplicatePath = await findDuplicatePathByHash(outputHash);
        if (duplicatePath) {
            try {
                await fsp.unlink(srcPath);
            } catch (error) {
                if (error.code !== 'ENOENT') throw error;
            }
            console.log(`⏭️ 已去重: ${safeFilename} 与 ${path.basename(duplicatePath)} 内容相同，已跳过`);
            return 'duplicate';
        }

        // 输出文件名统一改为 .webp
        const rawBaseName = path.basename(safeFilename, path.extname(safeFilename));
        const baseName = rawBaseName || `img_${Date.now()}`;
        let uniqueSuffix = 0;
        let finalPath = path.join(destDir, `${baseName}.webp`);
        while (await fileExists(finalPath)) {
            uniqueSuffix += 1;
            finalPath = path.join(destDir, `${baseName}_${Date.now()}_${uniqueSuffix}.webp`);
        }

        // 写入目标文件
        await fsp.writeFile(finalPath, outputBuffer);
        if (imageHashIndexReady) {
            const relativePath = toRelativeImagePath(finalPath);
            setImageHashIndexEntry(relativePath, outputHash);
            schedulePersistImageHashIndex();
        }

        // 删除原文件
        try {
            await fsp.unlink(srcPath);
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }

        const type = isHorizontal ? '横屏' : '竖屏';
        const originalSize = (buffer.length / 1024).toFixed(0);
        const newSize = (outputBuffer.length / 1024).toFixed(0);
        console.log(`✅ 已分类: ${safeFilename} → ${type} (${width}x${height}) | ${originalSize}KB → ${newSize}KB WebP (q${usedQuality})`);

        // 刷新图片列表
        if (refreshList) {
            initImageLists();
        }

        return 'classified';
    } catch (error) {
        console.error(`❌ 分类失败 ${safeFilename}:`, error.message);
        return 'failed';
    }
}

async function classifyFilesBatch(files, options = {}) {
    const fileList = Array.isArray(files) ? files.filter(Boolean) : [];
    const concurrency = parseBoundedInt(options.concurrency, CLASSIFY_CONCURRENCY, 1, 8);
    const refreshList = options.refreshList !== false;

    const stats = {
        total: fileList.length,
        classified: 0,
        duplicated: 0,
        failed: 0,
        skipped: 0
    };

    if (fileList.length === 0) {
        return stats;
    }

    let cursor = 0;
    const workerCount = Math.min(concurrency, fileList.length);
    const workers = Array.from({ length: workerCount }, async () => {
        while (true) {
            const idx = cursor;
            cursor += 1;
            if (idx >= fileList.length) break;

            const result = await classifyImage(fileList[idx], { refreshList: false });
            if (result === 'classified') stats.classified += 1;
            else if (result === 'duplicate') stats.duplicated += 1;
            else if (result === 'skipped') stats.skipped += 1;
            else stats.failed += 1;
        }
    });

    await Promise.all(workers);

    if (refreshList && stats.classified > 0) {
        initImageLists();
    }

    return stats;
}

// 处理 inbox 目录中的所有图片
async function processInbox() {
    const files = scanImageDirectory(INBOX_PATH);

    if (files.length === 0) {
        return { total: 0, classified: 0, duplicated: 0, failed: 0, skipped: 0 };
    }

    console.log(`\n📥 发现 ${files.length} 张待分类图片...`);
    return classifyFilesBatch(files, { concurrency: CLASSIFY_CONCURRENCY, refreshList: true });
}

// 监听目录变化
function watchDirectories() {
    const inboxTimers = new Map();

    // 监听 inbox 目录 - 自动分类
    if (fs.existsSync(INBOX_PATH)) {
        fs.watch(INBOX_PATH, (eventType, filename) => {
            const name = typeof filename === 'string' ? filename : filename ? filename.toString() : '';
            if (!name) return;
            const ext = path.extname(name).toLowerCase();
            if (!SUPPORTED_FORMAT_SET.has(ext)) return;

            if (inboxTimers.has(name)) {
                clearTimeout(inboxTimers.get(name));
            }

            // 延迟处理，确保文件写入完成
            const timer = setTimeout(() => {
                inboxTimers.delete(name);
                classifyImage(name).catch(error => {
                    console.error(`❌ 自动分类失败 ${name}:`, error.message);
                });
            }, 500);
            inboxTimers.set(name, timer);
        });
        console.log(`📥 监听待分类目录: ${INBOX_PATH}`);
    }

    // 监听 h 和 v 目录 - 刷新列表
    let debounceTimer = null;
    const debounceRefresh = () => {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            markImageHashIndexDirty();
            initImageLists();
        }, 1000);
    };

    [H_PATH, V_PATH].forEach(dir => {
        if (fs.existsSync(dir)) {
            fs.watch(dir, (eventType, filename) => {
                const name = typeof filename === 'string' ? filename : filename ? filename.toString() : '';
                if (name && SUPPORTED_FORMAT_SET.has(path.extname(name).toLowerCase())) {
                    debounceRefresh();
                }
            });
        }
    });
    console.log(`👀 监听图片目录: ri/h, ri/v`);
}

// 检测是否为移动设备
function isMobileDevice(userAgent) {
    if (!userAgent) return false;
    const mobileKeywords = ['Mobile', 'Android', 'iPhone', 'iPad', 'iPod', 'BlackBerry', 'Windows Phone', 'Opera Mini', 'IEMobile', 'Tablet'];
    const lowerUA = userAgent.toLowerCase();
    return mobileKeywords.some(k => lowerUA.includes(k.toLowerCase())) || /android|iphone|ipad|ipod/i.test(userAgent);
}

function buildImageResource(type, filename) {
    const baseName = path.basename(filename, path.extname(filename));
    return {
        url: `/ri/${type}/${filename}`,
        type,
        thumbUrl: `/ri/thumb/${type}/${baseName}.webp`
    };
}

// 获取随机图片信息
function getRandomImageInfo(imageList, type) {
    if (imageList.length === 0) return null;
    const randomIndex = Math.floor(Math.random() * imageList.length);
    const filename = imageList[randomIndex];
    return {
        ...buildImageResource(type, filename),
        filePath: path.join(type === 'h' ? H_PATH : V_PATH, filename)
    };
}

// 静态文件服务
app.use('/ri', express.static(RI_PATH, {
    maxAge: '30d',
    etag: true,
    immutable: true
}));

// 缩略图服务 (动态生成并缓存)
app.get('/thumb', async (req, res) => {
    try {
        const resolved = resolveImagePathFromUrlPath(req.query.src);
        if (!resolved) {
            return res.status(400).send('❌ 参数错误');
        }

        if (!(await fileExists(resolved.filePath))) {
            return res.status(404).send('❌ 原图不存在');
        }

        if (!(await fileExists(resolved.thumbPath))) {
            const thumbKey = `${resolved.type}/${resolved.relativeName}`;
            let thumbJob = thumbInFlight.get(thumbKey);
            if (!thumbJob) {
                console.log(`🖼️ [Thumb] 生成缩略图: ${resolved.relativeName}`);
                thumbJob = sharp(resolved.filePath)
                    .resize({ width: 400, withoutEnlargement: true }) // 高度自适应，最高宽度 400px
                    .webp({ quality: 80 }) // 压缩为 80% 画质的 WebP
                    .toFile(resolved.thumbPath);
                thumbInFlight.set(thumbKey, thumbJob);
            }

            try {
                await thumbJob;
            } finally {
                if (thumbInFlight.get(thumbKey) === thumbJob) {
                    thumbInFlight.delete(thumbKey);
                }
            }
        }

        res.set('Content-Type', 'image/webp');
        res.set('Cache-Control', 'public, max-age=2592000, immutable');
        res.sendFile(resolved.thumbPath);

    } catch (e) {
        console.error('❌ 生成缩略图失败:', e.message);
        res.status(500).send('生成缩略图失败');
    }
});

// 手动刷新
app.get('/refresh', createCooldownMiddleware('refresh', 1000), (req, res) => {
    markImageHashIndexDirty();
    initImageLists();
    res.json({ success: true, horizontal: horizontalImages.length, vertical: verticalImages.length });
});

// 手动触发分类
app.get('/classify', createCooldownMiddleware('classify', 1000), async (req, res) => {
    const before = { h: horizontalImages.length, v: verticalImages.length };
    const result = await processInbox();
    const after = { h: horizontalImages.length, v: verticalImages.length };

    res.json({
        success: true,
        message: '分类完成',
        added: { horizontal: after.h - before.h, vertical: after.v - before.v },
        processed: result.total,
        duplicated: result.duplicated,
        skipped: result.skipped,
        failed: result.failed
    });
});

// 图片列表 API (画廊页面使用，支持分页)
app.get('/api/images', (req, res) => {
    const type = req.query.type === 'h' || req.query.type === 'v' ? req.query.type : 'all';
    const page = parseBoundedInt(req.query.page, 1, 1, 1000000);
    const pageSize = parseBoundedInt(req.query.pageSize, 12, 1, 100); // 默认 12 张，最大 100
    res.set('Access-Control-Allow-Origin', '*');

    const start = (page - 1) * pageSize;
    const end = start + pageSize;
    let total = 0;
    let paginatedImages = [];

    if (type === 'h') {
        total = horizontalImages.length;
        paginatedImages = horizontalImages.slice(start, end).map(f => buildImageResource('h', f));
    } else if (type === 'v') {
        total = verticalImages.length;
        paginatedImages = verticalImages.slice(start, end).map(f => buildImageResource('v', f));
    } else {
        const horizontalTotal = horizontalImages.length;
        const verticalTotal = verticalImages.length;
        total = horizontalTotal + verticalTotal;

        if (start < horizontalTotal) {
            const hSlice = horizontalImages.slice(start, Math.min(end, horizontalTotal))
                .map(f => buildImageResource('h', f));
            paginatedImages = paginatedImages.concat(hSlice);
        }

        if (end > horizontalTotal) {
            const vStart = Math.max(0, start - horizontalTotal);
            const vEnd = end - horizontalTotal;
            const vSlice = verticalImages.slice(vStart, vEnd)
                .map(f => buildImageResource('v', f));
            paginatedImages = paginatedImages.concat(vSlice);
        }
    }

    const totalPages = total === 0 ? 0 : Math.ceil(total / pageSize);

    res.json({
        total,
        horizontal: horizontalImages.length,
        vertical: verticalImages.length,
        page,
        pageSize,
        totalPages,
        hasMore: page < totalPages,
        images: paginatedImages
    });
});

// 随机图片 API
app.get('/pic', (req, res) => {
    try {
        const imgType = req.query.img;
        res.set('Access-Control-Allow-Origin', '*');
        const useRedirect = req.query.redirect === '1';

        const sendRandomImage = (type, list, missingMessage) => {
            const info = getRandomImageInfo(list, type);
            if (!info) {
                return res.status(404).send(missingMessage);
            }
            res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
            if (useRedirect) {
                return res.redirect(302, info.url);
            }
            return res.sendFile(info.filePath);
        };

        if (imgType === 'h') {
            return sendRandomImage('h', horizontalImages, '❌ 没有找到横屏图片');
        }

        if (imgType === 'v') {
            return sendRandomImage('v', verticalImages, '❌ 没有找到竖屏图片');
        }

        if (imgType === 'ua') {
            const isMobile = isMobileDevice(req.headers['user-agent'] || '');
            const primaryType = isMobile ? 'v' : 'h';
            const secondaryType = isMobile ? 'h' : 'v';
            const primaryList = isMobile ? verticalImages : horizontalImages;
            const secondaryList = isMobile ? horizontalImages : verticalImages;

            // 优先按设备方向选择，空库时降级到另一类，避免 404
            if (primaryList.length > 0) {
                return sendRandomImage(primaryType, primaryList, '❌ 没有找到图片');
            }
            return sendRandomImage(secondaryType, secondaryList, '❌ 没有找到图片');
        }

        // 使用说明页面
        res.sendFile(path.join(__dirname, 'api.html'));

    } catch (error) {
        res.status(500).send(`❌ 错误: ${error.message}`);
    }
});

// 上传图片 API
app.post('/api/upload', requireAuth, upload.array('images', 20), (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    if (!req.files || req.files.length === 0) {
        return res.status(400).json({ success: false, message: '没有上传文件' });
    }
    const uploaded = req.files.map(f => f.filename);

    // 延迟一下让文件系统稳定，然后触发分类压缩
    setTimeout(async () => {
        try {
            const batchDedupe = await dedupeInboxFilesBySourceHash(uploaded);
            const result = await classifyFilesBatch(batchDedupe.files, {
                concurrency: CLASSIFY_CONCURRENCY,
                refreshList: true
            });
            const duplicatedTotal = result.duplicated + batchDedupe.duplicated;
            if (duplicatedTotal > 0) {
                console.log(`⏭️ 上传去重完成: 跳过 ${duplicatedTotal} 张重复图片`);
            }
        } catch (error) {
            console.error('❌ 上传后自动分类失败:', error.message);
        }
    }, 500).unref?.();

    res.json({ success: true, message: `已接收 ${uploaded.length} 张图片，后台处理中`, files: uploaded });
});

// 删除图片 API
app.delete('/api/delete', requireAuth, express.json(), async (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'DELETE, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, x-admin-password');

    const { url } = req.body;
    if (!url || typeof url !== 'string') {
        return res.status(400).json({ success: false, message: '缺少图片URL参数' });
    }

    try {
        const resolved = resolveImagePathFromUrlPath(url);
        if (!resolved) {
            return res.status(400).json({ success: false, message: '图片URL无效' });
        }

        // 检查文件是否存在
        if (!(await fileExists(resolved.filePath))) {
            return res.status(404).json({ success: false, message: '文件不存在' });
        }

        // 删除文件
        await fsp.unlink(resolved.filePath);
        removeFileFromHashIndex(resolved.filePath);
        // 尝试删除对应缩略图，避免脏缓存
        await fsp.unlink(resolved.thumbPath).catch(error => {
            if (error.code !== 'ENOENT') throw error;
        });

        // 刷新图片列表
        initImageLists();

        console.log(`🗑️ 已删除: ${url}`);
        res.json({ success: true, message: '图片已删除' });
    } catch (error) {
        console.error('❌ 删除失败:', error.message);
        res.status(500).json({ success: false, message: '删除失败: ' + error.message });
    }
});

// 处理 OPTIONS 请求 (CORS 预检)
app.options('/api/delete', (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'DELETE, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, x-admin-password');
    res.sendStatus(204);
});

app.options('/api/upload', (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, x-admin-password');
    res.sendStatus(204);
});

// 首页 - 直接显示画廊
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'gallery.html'));
});

// 兼容旧的 /gallery 路径
app.get('/gallery', (req, res) => {
    res.redirect('/');
});

// 启动
ensureDirectories();
initImageLists();
ensureImageHashIndex().catch(error => {
    console.error('❌ 初始化去重索引失败:', error.message);
});
processInbox().catch(error => {
    console.error('❌ 启动分类失败:', error.message);
}); // 启动时处理已有的待分类图片
watchDirectories();

app.listen(PORT, () => {
    console.log(`\n🚀 服务器已启动: http://localhost:${PORT}`);
    console.log(`📷 随机图片: http://localhost:${PORT}/pic?img=h`);
    console.log(`\n💡 把图片放到 ri/inbox 目录，会自动分类！`);
});
