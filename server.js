const express = require('express');
const path = require('path');
const fs = require('fs');
const sizeOf = require('image-size');

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

// 确保目录存在
function ensureDirectories() {
    [RI_PATH, H_PATH, V_PATH, INBOX_PATH].forEach(dir => {
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

        // 获取图片尺寸
        const dimensions = sizeOf(srcPath);
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

        // 使用说明
        res.set('Content-Type', 'text/plain; charset=utf-8');
        res.send(`🖼️ 随机图片 API

使用方法:
• ?img=h  - 横屏随机图片
• ?img=v  - 竖屏随机图片
• ?img=ua - 根据设备自动选择

其他 API:
• /refresh  - 刷新图片列表
• /classify - 手动触发分类

自动分类:
📥 把图片放到 ri/inbox 目录，会自动分类到 h 或 v

支持格式: ${SUPPORTED_FORMATS.join(', ')}

当前图片:
• 横屏: ${horizontalImages.length} 张
• 竖屏: ${verticalImages.length} 张`);

    } catch (error) {
        res.status(500).send(`❌ 错误: ${error.message}`);
    }
});

// 首页
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
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
