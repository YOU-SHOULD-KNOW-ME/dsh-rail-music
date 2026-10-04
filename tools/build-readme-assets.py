"""Draw original README artwork and assemble captured plugin demo frames."""
from pathlib import Path
import colorsys
import math

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'docs' / 'assets'
OUT.mkdir(parents=True, exist_ok=True)
FONT = Path('C:/Windows/Fonts')


def font(size, face='normal'):
    names = {'normal': 'msyh.ttc', 'bold': 'msyhbd.ttc', 'mono': 'consola.ttf', 'latin': 'seguisb.ttf'}
    return ImageFont.truetype(str(FONT / names[face]), size)


def text(draw, xy, value, size=24, fill='#b7bccf', face='normal'):
    draw.text(xy, value, font=font(size, face), fill=fill)


def rounded(draw, box, fill, outline=None, radius=16, width=1):
    draw.rounded_rectangle(box, radius, fill=fill, outline=outline, width=width)


def spectrum(draw, x, y, width, height, theme='aurora', count=32, active=None, neutral=False):
    presets = {'rainbow': (265, 0, .85), 'aurora': (265, 160, .72), 'ember': (55, 20, .88), 'mono': (210, 210, 0)}
    top, bottom, sat = presets[theme]
    for i in range(count):
        t = i / (count - 1)
        yy = y + t * height
        value = .17 + .4 * t + .2 * math.sin(i * .52) ** 2 + .1 * math.sin(i * 1.31) ** 2
        if i == active:
            value = .97
        length = 28 if neutral else width * value
        light = .84 if i == active else .58
        rgb = colorsys.hls_to_rgb((top + (bottom - top) * t) / 360, light, sat)
        color = tuple(round(c * 255) for c in rgb) if not neutral else ((239, 241, 246) if i == active else (99, 104, 119))
        draw.line((x + width - length, yy, x + width, yy), fill=color, width=4)
        draw.ellipse((x + width - 2, yy - 2, x + width + 2, yy + 2), fill=color)


def hero():
    image = Image.new('RGB', (1600, 900), '#101118')
    d = ImageDraw.Draw(image)
    # A subtle grid and typography give the poster its structure.
    for x in range(32, 1600, 56):
        for y in range(32, 900, 56):
            d.ellipse((x, y, x + 1, y + 1), fill='#252836')
    text(d, (88, 70), 'DSH / AUDIO VISUALIZER', 22, '#83e4cf', 'mono')
    text(d, (88, 157), 'RAIL', 118, '#f0f2f8', 'latin')
    text(d, (88, 288), 'MUSIC', 118, '#f0f2f8', 'latin')
    text(d, (92, 459), '让对话，有点节奏。', 48, '#f0f2f8', 'bold')
    text(d, (94, 544), '把正在播放的声音，接到 DSH 的轮次导航轨道上。', 24, '#a9adbd')
    for label, box in [('系统音频', (94, 625, 228, 672)), ('频谱律动', (242, 625, 376, 672)), ('导航优先', (390, 625, 524, 672))]:
        rounded(d, box, '#191c26', '#383d51', 23)
        text(d, (box[0] + 18, box[1] + 8), label, 22, '#d0d5e2')
    # Abstract conversation art; explicitly separate from the real-render demo.
    rounded(d, (880, 112, 1508, 748), '#171a24', '#383d51', 30)
    d.line((918, 173, 1468, 173), fill='#2c3143', width=1)
    text(d, (918, 135), 'CONVERSATION / NOW PLAYING', 17, '#8e97ad', 'mono')
    for y, lengths in [(230, [250, 198]), (360, [282, 248, 160]), (535, [265, 204])]:
        d.ellipse((918, y, 940, y + 22), fill='#647796')
        for n, length in enumerate(lengths):
            rounded(d, (962, y + 4 + n * 24, 962 + length, y + 10 + n * 24), '#343a4e', radius=3)
    spectrum(d, 1270, 225, 170, 395, active=23)
    text(d, (1275, 674), 'SPECTRUM RAIL', 16, '#717c96', 'mono')
    d.line((88, 798, 1512, 798), fill='#30354a', width=1)
    text(d, (90, 824), 'WIN / LINUX / MAC  ·  DSH WEB', 20, '#99a4bc', 'mono')
    text(d, (1270, 823), 'v0.3.0 / MIT', 20, '#83e4cf', 'mono')
    image.save(OUT / 'hero.png', optimize=True)


def themes():
    image = Image.new('RGB', (1600, 770), '#101118')
    d = ImageDraw.Draw(image)
    text(d, (64, 48), 'CHOOSE YOUR FREQUENCY', 22, '#83e4cf', 'mono')
    text(d, (64, 94), '同一首歌，四种氛围。', 42, '#f0f2f8', 'bold')
    data = [('rainbow', '经典频谱', '鲜明的频率色阶'), ('aurora', '极光', '蓝紫与青绿的夜色'),
            ('ember', '暖焰', '偏暖的轻柔色调'), ('mono', '单色', '专注于长度与明暗')]
    for i, (theme, label, caption) in enumerate(data):
        x = 64 + i * 380
        rounded(d, (x, 200, x + 350, 702), '#181b25', '#33394b', 24)
        text(d, (x + 25, 230), f'0{i + 1} / {theme.upper()}', 20, '#838da7', 'mono')
        spectrum(d, x + 96, 288, 165, 256, theme, 25, active=18)
        text(d, (x + 25, 586), label, 32, '#eef1f7', 'bold')
        text(d, (x + 25, 644), caption, 20, '#99a4bc')
    image.save(OUT / 'themes.png', optimize=True)


def settings():
    # Crop the existing plugin screenshot; never redraw the actual controls.
    dark = Image.open(ROOT / 'shots/review/aurora-settings.png').convert('RGB')
    light = Image.open(ROOT / 'shots/review/light-settings.png').convert('RGB')
    image = Image.new('RGB', (1600, 780), '#101118')
    d = ImageDraw.Draw(image)
    text(d, (64, 42), 'MAKE IT YOURS', 22, '#83e4cf', 'mono')
    text(d, (64, 88), '一点设置，刚好的律动。', 42, '#f0f2f8', 'bold')
    for x, source, label in [(64, dark, 'DARK'), (840, light, 'LIGHT')]:
        rounded(d, (x, 191, x + 696, 714), '#191c27', '#353b50', 24)
        text(d, (x + 24, 211), label, 20, '#9aa7c1', 'mono')
        crop = source.crop((1008, 0, 1280, 374)).resize((294, 404), Image.Resampling.LANCZOS)
        image.paste(crop, (x + 200, 268))
    image.save(OUT / 'settings.png', optimize=True)


def assemble_demo():
    folder = ROOT / 'dist/readme-frames'
    paths = sorted(folder.glob('*.png'))
    if not paths:
        return
    frames = [Image.open(path).convert('RGB') for path in paths]
    palette = frames[0].quantize(colors=160)
    indexed = [frame.quantize(palette=palette, dither=Image.Dither.NONE) for frame in frames]
    indexed[0].save(OUT / 'demo.gif', save_all=True, append_images=indexed[1:], duration=70,
                    loop=0, optimize=False, disposal=2)
    frames[0].save(OUT / 'demo-still.png', optimize=True)


if __name__ == '__main__':
    hero()
    themes()
    settings()
    assemble_demo()
    for path in OUT.iterdir():
        print(f'{path.name}: {path.stat().st_size} bytes')
