const express = require('express');
const path = require('path');
const fs = require('fs');
const { imageSize } = require('image-size');
const multer = require('multer');
const sharp = require('sharp');

// 配置 multer 存储
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, path.join(__dirname, 'ri', 'inbox')),
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
        if (['.webp', '.avif', '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.ico', '.svg'].includes(ext)) {
            cb(null, true);
        } else {
            cb(new Error('不支持的图片格式'));
        }
    },
    limits: { fileSize: 50 * 1024 * 1024 } // 50MB 限制
});

const app = express();
const PORT = process.env.PORT || 3122;

// 支持的图片格式
const SUPPORTED_FORMATS = ['.webp', '.avif', '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.ico', '.svg'];

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
            return SUPPORTED_FORMATS.includes(ext);
        });
    } catch (error) {
        console.error(`❌ 扫描目录失败 ${dirPath}:`, error.message);
        return [];
    }
}

// 初始化图片列表
function initImageLists() {
    horizontalImages = scanImageDirectory(H_PATH);
    verticalImages = scanImageDirectory(V_PATH);

    console.log(`📁 横屏图片: ${horizontalImages.length} 张 | 竖屏图片: ${verticalImages.length} 张`);
}

// 自动分类单个图片
function classifyImage(filename) {
    const srcPath = path.join(INBOX_PATH, filename);

    try {
        // 检查文件是否存在
        if (!fs.existsSync(srcPath)) return;

        // 获取图片尺寸 (image-size v2 需要传入 buffer)
        const buffer = fs.readFileSync(srcPath);
        const dimensions = imageSize(buffer);
        const { width, height } = dimensions;

        // 判断横屏还是竖屏
        const isHorizontal = width >= height;
        const destDir = isHorizontal ? H_PATH : V_PATH;
        const destPath = path.join(destDir, filename);

        // 如果目标文件已存在，添加时间戳
        let finalPath = destPath;
        if (fs.existsSync(destPath)) {
            const ext = path.extname(filename);
            const name = path.basename(filename, ext);
            finalPath = path.join(destDir, `${name}_${Date.now()}${ext}`);
        }

        // 移动文件
        fs.renameSync(srcPath, finalPath);

        const type = isHorizontal ? '横屏' : '竖屏';
        console.log(`✅ 已分类: ${filename} → ${type} (${width}x${height})`);

        // 刷新图片列表
        initImageLists();

    } catch (error) {
        console.error(`❌ 分类失败 ${filename}:`, error.message);
    }
}

// 处理 inbox 目录中的所有图片
function processInbox() {
    const files = scanImageDirectory(INBOX_PATH);

    if (files.length === 0) return;

    console.log(`\n📥 发现 ${files.length} 张待分类图片...`);
    files.forEach(file => classifyImage(file));
}

// 监听目录变化
function watchDirectories() {
    // 监听 inbox 目录 - 自动分类
    if (fs.existsSync(INBOX_PATH)) {
        fs.watch(INBOX_PATH, (eventType, filename) => {
            if (!filename) return;
            const ext = path.extname(filename).toLowerCase();
            if (!SUPPORTED_FORMATS.includes(ext)) return;

            // 延迟处理，确保文件写入完成
            setTimeout(() => classifyImage(filename), 500);
        });
        console.log(`� 监听待分类目录: ${INBOX_PATH}`);
    }

    // 监听 h 和 v 目录 - 刷新列表
    let debounceTimer = null;
    const debounceRefresh = () => {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(initImageLists, 1000);
    };

    [H_PATH, V_PATH].forEach(dir => {
        if (fs.existsSync(dir)) {
            fs.watch(dir, (eventType, filename) => {
                if (filename && SUPPORTED_FORMATS.includes(path.extname(filename).toLowerCase())) {
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

// 获取随机图片
function getRandomImage(imageList, type) {
    if (imageList.length === 0) return null;
    const randomIndex = Math.floor(Math.random() * imageList.length);
    return `/ri/${type}/${imageList[randomIndex]}`;
}

// 静态文件服务
app.use('/ri', express.static(RI_PATH));

// 缩略图服务 (动态生成并缓存)
app.get('/thumb', async (req, res) => {
    try {
        const srcUrl = req.query.src;
        if (!srcUrl || !srcUrl.startsWith('/ri/')) {
            return res.status(400).send('❌ 参数错误');
        }

        // 解析原始文件路径
        // srcUrl 格式如: /ri/h/image.jpg
        const parts = srcUrl.split('/');
        if (parts.length < 4) return res.status(400).send('❌ 路径无效');

        const type = parts[2]; // 'h' 或 'v'
        const filename = parts.slice(3).join('/'); // 'image.jpg'

        if (type !== 'h' && type !== 'v') return res.status(400).send('❌ 类型无效');

        const originalPath = path.join(type === 'h' ? H_PATH : V_PATH, filename);
        if (!fs.existsSync(originalPath)) {
            return res.status(404).send('❌ 原图不存在');
        }

        // 构建缩略图路径并强制转为 webp 以减小体积
        const thumbFilename = path.basename(filename, path.extname(filename)) + '.webp';
        const thumbDir = type === 'h' ? THUMB_H_PATH : THUMB_V_PATH;
        const thumbPath = path.join(thumbDir, thumbFilename);

        // 如果缩略图已存在，直接返回
        if (fs.existsSync(thumbPath)) {
            res.set('Content-Type', 'image/webp');
            return res.sendFile(thumbPath);
        }

        // 生成缩略图
        console.log(`🖼️ [Thumb] 生成缩略图: ${filename}`);
        await sharp(originalPath)
            .resize({ width: 400, withoutEnlargement: true }) // 高度自适应，最高宽度 400px
            .webp({ quality: 80 }) // 压缩为 80% 画质的 WebP
            .toFile(thumbPath);

        res.set('Content-Type', 'image/webp');
        res.sendFile(thumbPath);

    } catch (e) {
        console.error('❌ 生成缩略图失败:', e.message);
        res.status(500).send('生成缩略图失败');
    }
});

// 手动刷新
app.get('/refresh', (req, res) => {
    initImageLists();
    res.json({ success: true, horizontal: horizontalImages.length, vertical: verticalImages.length });
});

// 手动触发分类
app.get('/classify', (req, res) => {
    const before = { h: horizontalImages.length, v: verticalImages.length };
    processInbox();
    const after = { h: horizontalImages.length, v: verticalImages.length };
    res.json({
        success: true,
        message: '分类完成',
        added: { horizontal: after.h - before.h, vertical: after.v - before.v }
    });
});

// 图片列表 API (画廊页面使用，支持分页)
app.get('/api/images', (req, res) => {
    const type = req.query.type || 'all';
    const page = parseInt(req.query.page) || 1;
    const pageSize = parseInt(req.query.pageSize) || 12; // 默认 12 张
    res.set('Access-Control-Allow-Origin', '*');

    let images = [];
    if (type === 'h' || type === 'all') {
        images = images.concat(horizontalImages.map(f => ({ url: `/ri/h/${f}`, type: 'h' })));
    }
    if (type === 'v' || type === 'all') {
        images = images.concat(verticalImages.map(f => ({ url: `/ri/v/${f}`, type: 'v' })));
    }

    const total = images.length;
    const totalPages = Math.ceil(total / pageSize);
    const start = (page - 1) * pageSize;
    const end = start + pageSize;
    const paginatedImages = images.slice(start, end);

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

        if (imgType === 'h') {
            const imageUrl = getRandomImage(horizontalImages, 'h');
            if (!imageUrl) return res.status(404).send('❌ 没有找到横屏图片');
            res.set('Cache-Control', 'no-cache');
            return res.redirect(302, imageUrl);
        }

        if (imgType === 'v') {
            const imageUrl = getRandomImage(verticalImages, 'v');
            if (!imageUrl) return res.status(404).send('❌ 没有找到竖屏图片');
            res.set('Cache-Control', 'no-cache');
            return res.redirect(302, imageUrl);
        }

        if (imgType === 'ua') {
            const isMobile = isMobileDevice(req.headers['user-agent'] || '');
            const imageUrl = isMobile
                ? getRandomImage(verticalImages, 'v')
                : getRandomImage(horizontalImages, 'h');
            if (!imageUrl) return res.status(404).send('❌ 没有找到图片');
            res.set('Cache-Control', 'no-cache');
            return res.redirect(302, imageUrl);
        }

        // 使用说明页面
        res.sendFile(path.join(__dirname, 'api.html'));

    } catch (error) {
        res.status(500).send(`❌ 错误: ${error.message}`);
    }
});

// 上传图片 API
app.post('/api/upload', upload.array('images', 20), (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    if (!req.files || req.files.length === 0) {
        return res.status(400).json({ success: false, message: '没有上传文件' });
    }
    const uploaded = req.files.map(f => f.filename);
    // 延迟一下让文件系统稳定，然后触发分类
    setTimeout(() => {
        req.files.forEach(f => classifyImage(f.filename));
    }, 500);
    res.json({ success: true, message: `成功上传 ${uploaded.length} 张图片`, files: uploaded });
});

// 删除图片 API
app.delete('/api/delete', express.json(), (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'DELETE, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');

    const { url } = req.body;
    if (!url) {
        return res.status(400).json({ success: false, message: '缺少图片URL参数' });
    }

    try {
        // 从URL中提取文件路径，如 /ri/h/xxx.jpg
        const urlPath = url.replace(/^\//, ''); // 移除开头的 /
        const filePath = path.join(__dirname, urlPath);

        // 安全检查：确保文件在 ri 目录下
        const riPath = path.join(__dirname, 'ri');
        if (!filePath.startsWith(riPath)) {
            return res.status(403).json({ success: false, message: '无权删除该文件' });
        }

        // 检查文件是否存在
        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ success: false, message: '文件不存在' });
        }

        // 删除文件
        fs.unlinkSync(filePath);

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
    res.set('Access-Control-Allow-Headers', 'Content-Type');
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
processInbox();  // 启动时处理已有的待分类图片
watchDirectories();

app.listen(PORT, () => {
    console.log(`\n🚀 服务器已启动: http://localhost:${PORT}`);
    console.log(`📷 随机图片: http://localhost:${PORT}/pic?img=h`);
    console.log(`\n💡 把图片放到 ri/inbox 目录，会自动分类！`);
});
