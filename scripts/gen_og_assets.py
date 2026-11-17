# -*- coding: utf-8 -*-
"""生成 apple-touch-icon.png 与 Open Graph 分享卡片图。

使用 Pillow 纯 Python 绘制，并把 favicon.svg 中的 GitHub 猫路径按三次贝塞尔
曲线采样后填充，保证与站点现有图标视觉一致。可重复运行覆盖产出。

用法：python scripts/gen_og_assets.py
"""
import re
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
PUBLIC = ROOT / "public"

FONT_BOLD = "C:/Windows/Fonts/msyhbd.ttc"
FONT_REG = "C:/Windows/Fonts/msyh.ttc"

# 直接从 favicon.svg 读取 GitHub 猫图标路径（viewBox 64 64），避免手工转录出错
def _load_path():
    svg = (PUBLIC / "favicon.svg").read_text(encoding="utf-8")
    m = re.search(r'\bd="([^"]+)"', svg)
    if not m:
        raise RuntimeError("favicon.svg 中未找到 path d 属性")
    return m.group(1)


GITHUB_PATH = _load_path()

_TOKENS = re.compile(r"[MmCcSsZzLlHhVv]|-?\d*\.?\d+(?:[eE][-+]?\d+)?")


def parse_path(d):
    """极简 SVG path 解析：支持 M/c/s/l/h/v/z 及隐式重复命令。"""
    tokens = _TOKENS.findall(d)
    subpaths, cur = [], []
    cx = cy = sx = sy = 0.0
    last_ctrl2 = None  # 上一条三次曲线的第二控制点（绝对坐标），供 s 反射使用
    cmd = None
    i = 0

    def num():
        nonlocal i
        v = float(tokens[i])
        i += 1
        return v

    def bezier(p0, p1, p2, p3, steps=18):
        out = []
        for k in range(1, steps + 1):
            t = k / steps
            mt = 1 - t
            x = mt**3 * p0[0] + 3 * mt * mt * t * p1[0] + 3 * mt * t * t * p2[0] + t**3 * p3[0]
            y = mt**3 * p0[1] + 3 * mt * mt * t * p1[1] + 3 * mt * t * t * p2[1] + t**3 * p3[1]
            out.append((x, y))
        return out

    while i < len(tokens):
        t = tokens[i]
        if t in "MmCcSsZzLlHhVv":
            cmd = t
            i += 1
            if cmd in "Zz":
                if cur:
                    subpaths.append(cur)
                    cur = []
                cx, cy = sx, sy
                last_ctrl2 = None
                continue
        if cmd in "Mm":
            x, y = num(), num()
            if cmd == "m":
                x, y = cx + x, cy + y
            if cur:
                subpaths.append(cur)
            cur = [(x, y)]
            cx = sx = x
            cy = sy = y
            last_ctrl2 = None
            cmd = "l" if cmd == "m" else "L"
        elif cmd in "Cc":
            x1, y1, x2, y2, x, y = num(), num(), num(), num(), num(), num()
            if cmd == "c":
                x1 += cx; y1 += cy; x2 += cx; y2 += cy; x += cx; y += cy
            cur.extend(bezier((cx, cy), (x1, y1), (x2, y2), (x, y)))
            cx, cy = x, y
            last_ctrl2 = (x2, y2)
        elif cmd in "Ss":
            x2, y2, x, y = num(), num(), num(), num()
            if cmd == "s":
                x2 += cx; y2 += cy; x += cx; y += cy
            if last_ctrl2 is not None:
                x1, y1 = 2 * cx - last_ctrl2[0], 2 * cy - last_ctrl2[1]
            else:
                x1, y1 = cx, cy
            cur.extend(bezier((cx, cy), (x1, y1), (x2, y2), (x, y)))
            cx, cy = x, y
            last_ctrl2 = (x2, y2)
        elif cmd in "Ll":
            x, y = num(), num()
            if cmd == "l":
                x, y = cx + x, cy + y
            cur.append((x, y))
            cx, cy = x, y
            last_ctrl2 = None
        elif cmd in "Hh":
            x = num()
            if cmd == "h":
                x += cx
            cur.append((x, cy))
            cx = x
            last_ctrl2 = None
        elif cmd in "Vv":
            y = num()
            if cmd == "v":
                y += cy
            cur.append((cx, y))
            cy = y
            last_ctrl2 = None
        else:
            raise ValueError("Unsupported command: %s" % cmd)
    if cur:
        subpaths.append(cur)
    return subpaths


_CAT_CACHE = None


def cat_points(box):
    """返回猫图标落在 box=(x, y, w, h) 内的点集（viewBox 64x64 等比缩放）。"""
    global _CAT_CACHE
    if _CAT_CACHE is None:
        _CAT_CACHE = parse_path(GITHUB_PATH)
    x0, y0, w, h = box
    s = w / 64.0
    return [
        [(x0 + px * s, y0 + py * s) for px, py in sub]
        for sub in _CAT_CACHE
    ]


def draw_cat(draw, box, fill):
    for sub in cat_points(box):
        draw.polygon(sub, fill=fill)


def make_apple_touch_icon():
    size = 180
    ss = 4  # 超采样抗锯齿
    S = size * ss
    img = Image.new("RGB", (S, S), (36, 41, 47))  # #24292f
    d = ImageDraw.Draw(img)
    # 猫图标留出边距，居中；iOS 会自行加圆角遮罩，这里用不透明方形背景
    pad = S * 0.14
    draw_cat(d, (pad, pad, S - 2 * pad, S - 2 * pad), (255, 255, 255))
    img = img.resize((size, size), Image.LANCZOS)
    out = PUBLIC / "apple-touch-icon.png"
    img.save(out, "PNG", optimize=True)
    print("wrote", out)


def make_og_image():
    W, H = 1200, 630
    ss = 2
    w, h = W * ss, H * ss
    img = Image.new("RGB", (w, h), (13, 17, 23))  # #0d1117 GitHub 深色底
    d = ImageDraw.Draw(img)

    s = ss  # 便于按逻辑像素书写

    # 右侧同心圆装饰，增加层次
    cx, cy = int(1080 * s), int(315 * s)
    for r, col in [(430, (22, 27, 34)), (330, (26, 32, 40)), (230, (30, 37, 46))]:
        d.ellipse(
            [cx - r * s, cy - r * s, cx + r * s, cy + r * s],
            fill=col,
        )

    # 左侧图标卡片
    card = [80 * s, 175 * s, 360 * s, 455 * s]
    d.rounded_rectangle(card, radius=28 * s, fill=(22, 27, 34))
    draw_cat(d, (108 * s, 203 * s, 224 * s, 224 * s), (255, 255, 255))

    fb = lambda size: ImageFont.truetype(FONT_BOLD, size * s)
    fr = lambda size: ImageFont.truetype(FONT_REG, size * s)

    # 右侧文案
    x = 410 * s
    d.text((x, 178 * s), "GitHub 收藏", font=fb(68), fill=(255, 255, 255))
    d.text((x, 278 * s), "有趣的开源项目", font=fb(46), fill=(121, 192, 255))
    d.rounded_rectangle([x, 356 * s, x + 60 * s, 359 * s], radius=2 * s, fill=(48, 54, 61))
    d.text((x, 388 * s), "收藏有趣的 GitHub 开源项目，发现值得关注的项目", font=fr(27), fill=(139, 148, 158))
    d.text((x, 436 * s), "自动解析介绍 · Star · Fork 数据", font=fr(24), fill=(110, 118, 129))

    d.text((x, 522 * s), "github.dyqn.com", font=fr(25), fill=(88, 96, 105))

    img = img.resize((W, H), Image.LANCZOS)
    out = PUBLIC / "og-image.png"
    img.save(out, "PNG", optimize=True)
    print("wrote", out)


if __name__ == "__main__":
    make_apple_touch_icon()
    make_og_image()
