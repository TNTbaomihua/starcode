# -*- coding: utf-8 -*-
"""生成 PWA 图标：黑金风格 ✦ 星标"""
from PIL import Image, ImageDraw, ImageFont
import os

OUT = r"C:\Users\toge\WorkBuddy\2026-09-21-11-52-34\star-expense\icons"
os.makedirs(OUT, exist_ok=True)

BG = (10, 10, 13, 255)
PURPLE_TOP = (167, 149, 255)
PURPLE = (123, 97, 255)
PURPLE_BOT = (94, 75, 209)


def find_font(size):
    candidates = [
        r"C:\Windows\Fonts\seguisb.ttf",
        r"C:\Windows\Fonts\segoeui.ttf",
        r"C:\Windows\Fonts\arialbd.ttf",
        r"C:\Windows\Fonts\arial.ttf",
    ]
    for p in candidates:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                pass
    return ImageFont.load_default()


def make_icon(size, maskable=False):
    s = size
    img = Image.new("RGBA", (s, s), BG)
    d = ImageDraw.Draw(img)

    # 微妙的金色氛围光
    glow = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gr = int(s * 0.55)
    gd.ellipse([s - gr, -gr * 0.6, s + gr * 0.4, gr * 0.5], fill=(123, 97, 255, 30))
    img = Image.alpha_composite(img, glow)
    d = ImageDraw.Draw(img)

    # maskable 图标需要留出安全区（内容约占 66%）
    cx, cy = s / 2, s / 2
    R = s * (0.30 if maskable else 0.34)  # 星标半径

    # 画四角星（追星 ✦）
    pts = []
    for i in range(8):
        ang = -3.14159265 / 2 + i * 3.14159265 / 4
        r = R if i % 2 == 0 else R * 0.34
        pts.append((cx + r * _cos(ang), cy + r * _sin(ang)))

    # 金色渐变填充
    star = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    sd = ImageDraw.Draw(star)
    sd.polygon(pts, fill=PURPLE + (255,))
    grad = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    gpx = grad.load()
    for y in range(s):
        t = y / max(1, s - 1)
        cr = int(PURPLE_TOP[0] + (PURPLE_BOT[0] - PURPLE_TOP[0]) * t)
        cg = int(PURPLE_TOP[1] + (PURPLE_BOT[1] - PURPLE_TOP[1]) * t)
        cb = int(PURPLE_TOP[2] + (PURPLE_BOT[2] - PURPLE_TOP[2]) * t)
        for x in range(s):
            gpx[x, y] = (cr, cg, cb, 255)
    # 用星形做蒙版
    mask = Image.new("L", (s, s), 0)
    md = ImageDraw.Draw(mask)
    md.polygon(pts, fill=255)
    img.paste(grad, (0, 0), mask)
    d = ImageDraw.Draw(img)

    # 金色细描边（非 maskable 时画圆角边框）
    if not maskable:
        bw = max(2, s // 128)
        d.rounded_rectangle([bw, bw, s - bw, s - bw], radius=int(s * 0.18),
                            outline=(123, 97, 255, 100), width=bw)

    # 小星点缀
    for (fx, fy, fr) in [(0.78, 0.24, 0.045), (0.22, 0.72, 0.035), (0.80, 0.74, 0.028)]:
        fxp, fyp = s * fx, s * fy
        frp = s * fr
        if maskable:
            fxp = s * 0.5 + (fx - 0.5) * s * 0.78
            fyp = s * 0.5 + (fy - 0.5) * s * 0.78
        mini = []
        for i in range(8):
            ang = -3.14159265 / 2 + i * 3.14159265 / 4
            r = frp if i % 2 == 0 else frp * 0.36
            mini.append((fxp + r * _cos(ang), fyp + r * _sin(ang)))
        d.polygon(mini, fill=(123, 97, 255, 200))

    return img


def _cos(a):
    import math
    return math.cos(a)


def _sin(a):
    import math
    return math.sin(a)


make_icon(192, False).save(os.path.join(OUT, "icon-192.png"))
make_icon(512, False).save(os.path.join(OUT, "icon-512.png"))
make_icon(512, True).save(os.path.join(OUT, "icon-512-maskable.png"))
print("ICONS_OK")
