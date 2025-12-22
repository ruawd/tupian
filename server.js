const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3122;

// 图片数量配置
const maxHorizontalImageNumber = 882;
const maxVerticalImageNumber = 3289;

// 检测是否为移动设备
function isMobileDevice(userAgent) {
    if (!userAgent) return false;

    const mobileKeywords = [
        'Mobile', 'Android', 'iPhone', 'iPad', 'iPod', 'BlackBerry',
        'Windows Phone', 'Opera Mini', 'IEMobile', 'Mobile Safari',
        'webOS', 'Kindle', 'Silk', 'Fennec', 'Maemo', 'Tablet'
    ];

    const lowerUserAgent = userAgent.toLowerCase();

    for (let i = 0; i < mobileKeywords.length; i++) {
        if (lowerUserAgent.includes(mobileKeywords[i].toLowerCase())) {
            return true;
        }
    }

    const mobileRegex = /android|webos|iphone|ipad|ipod|blackberry|iemobile|opera mini/i;
    return mobileRegex.test(userAgent);
}

// 静态文件服务 - 提供图片目录
app.use('/ri', express.static(path.join(__dirname, 'ri')));

// 随机图片 API 路由
app.get('/pic', (req, res) => {
    try {
        const imgType = req.query.img;

        // 设置 CORS 头
        res.set('Access-Control-Allow-Origin', '*');

        if (imgType === 'h') {
            // 横屏随机图片
            const randomNum = Math.floor(Math.random() * maxHorizontalImageNumber) + 1;
            const imageUrl = '/ri/h/' + randomNum + '.webp';

            res.set('Cache-Control', 'no-cache');
            return res.redirect(302, imageUrl);

        } else if (imgType === 'v') {
            // 竖屏随机图片
            const randomNum = Math.floor(Math.random() * maxVerticalImageNumber) + 1;
            const imageUrl = '/ri/v/' + randomNum + '.webp';

            res.set('Cache-Control', 'no-cache');
            return res.redirect(302, imageUrl);

        } else if (imgType === 'ua') {
            // 根据 User-Agent 自动选择
            const userAgent = req.headers['user-agent'] || '';
            const isMobile = isMobileDevice(userAgent);

            if (isMobile) {
                const randomNum = Math.floor(Math.random() * maxVerticalImageNumber) + 1;
                const imageUrl = '/ri/v/' + randomNum + '.webp';
                res.set('Cache-Control', 'no-cache');
                return res.redirect(302, imageUrl);
            } else {
                const randomNum = Math.floor(Math.random() * maxHorizontalImageNumber) + 1;
                const imageUrl = '/ri/h/' + randomNum + '.webp';
                res.set('Cache-Control', 'no-cache');
                return res.redirect(302, imageUrl);
            }

        } else {
            // 显示使用说明
            let helpText = '🖼️ 随机图片展示器\n\n';
            helpText += '使用方法:\n';
            helpText += '• ?img=h - 获取横屏随机图片\n';
            helpText += '• ?img=v - 获取竖屏随机图片\n';
            helpText += '• ?img=ua - 根据设备类型自动选择图片\n';

            res.set('Content-Type', 'text/plain; charset=utf-8');
            return res.send(helpText);
        }

    } catch (error) {
        let errorDetails = '❌ 内部错误\n\n';
        errorDetails += '错误消息: ' + error.message + '\n';
        errorDetails += '错误堆栈: ' + error.stack + '\n';
        errorDetails += '时间戳: ' + new Date().toISOString();

        res.set('Content-Type', 'text/plain; charset=utf-8');
        return res.status(500).send(errorDetails);
    }
});

// 首页
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// 启动服务器
app.listen(PORT, () => {
    console.log(`🚀 服务器已启动: http://localhost:${PORT}`);
    console.log(`📷 图片 API: http://localhost:${PORT}/pic`);
    console.log(`   - 横屏: http://localhost:${PORT}/pic?img=h`);
    console.log(`   - 竖屏: http://localhost:${PORT}/pic?img=v`);
    console.log(`   - 自动: http://localhost:${PORT}/pic?img=ua`);
});
