const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const RI_PATH = path.join(__dirname, 'ri');
const H_PATH = path.join(RI_PATH, 'h');
const V_PATH = path.join(RI_PATH, 'v');
const THUMB_H_PATH = path.join(RI_PATH, 'thumb', 'h');
const THUMB_V_PATH = path.join(RI_PATH, 'thumb', 'v');
const SUPPORTED_FORMATS = ['.webp', '.avif', '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.ico', '.svg'];

// 确保缩略图目录存在
[THUMB_H_PATH, THUMB_V_PATH].forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
});

async function generateThumbnails(type, originalDir, thumbDir) {
    if (!fs.existsSync(originalDir)) return;

    const files = fs.readdirSync(originalDir).filter(f => SUPPORTED_FORMATS.includes(path.extname(f).toLowerCase()));
    console.log(`\n🔍 发现 ${files.length} 张 ${type === 'h' ? '横' : '竖'}屏原图，开始检查缩略图...`);

    let generated = 0;
    let skipped = 0;
    let failed = 0;

    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const originalPath = path.join(originalDir, file);
        const thumbFilename = path.basename(file, path.extname(file)) + '.webp';
        const thumbPath = path.join(thumbDir, thumbFilename);

        if (fs.existsSync(thumbPath)) {
            skipped++;
            process.stdout.write(`\r⏭️ 进度: ${i + 1}/${files.length} | 生成: ${generated} | 跳过: ${skipped} | 失败: ${failed}`);
            continue;
        }

        try {
            await sharp(originalPath)
                .resize({ width: 400, withoutEnlargement: true })
                .webp({ quality: 80 })
                .toFile(thumbPath);
            generated++;
            process.stdout.write(`\r✅ 进度: ${i + 1}/${files.length} | 生成: ${generated} | 跳过: ${skipped} | 失败: ${failed}`);
        } catch (error) {
            console.error(`\n❌ 处理 ${file} 失败:`, error.message);
            failed++;
        }
    }
    console.log(`\n🎉 ${type === 'h' ? '横' : '竖'}屏处理完成! (共生成 ${generated} 张，跳过 ${skipped} 张，失败 ${failed} 张)`);
}

async function run() {
    console.log('🚀 开始批量生成现存图片的缩略图...');
    await generateThumbnails('h', H_PATH, THUMB_H_PATH);
    await generateThumbnails('v', V_PATH, THUMB_V_PATH);
    console.log('\n✨ 所有缩略图预生成完毕！');
}

run();
