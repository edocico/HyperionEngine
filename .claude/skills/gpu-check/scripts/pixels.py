#!/usr/bin/env python3
"""Sample a chrome-devtools screenshot of the harness at WORLD coordinates.

Usage:
    pixels.py SHOT.png MAP.json X,Y [X,Y ...]
    pixels.py SHOT.png MAP.json --line X0,Y0:X1,Y1:N

MAP.json is what the gpu-check skill's evaluate_script returns:
    {"rect": [left, top, width, height],   # canvas getBoundingClientRect(), CSS px
     "vp": [16 floats],                    # engine.cam.viewProjection (column-major)
     "dpr": 1.25}                          # window.devicePixelRatio

The mapping that went wrong by hand on 2026-09-26: world -> clip through the
view-projection, clip -> CSS through the canvas rect, CSS -> screenshot pixels
through devicePixelRatio (NOT through canvas.width / rect.width).

Prints, per point: world, screenshot pixel, RGB, Rec. 709 luminance.
Needs Pillow (python3 -c "import PIL").
"""
import json
import sys

from PIL import Image


def to_pixel(m, x, y):
    vp = m["vp"]
    cx = vp[0] * x + vp[4] * y + vp[12]
    cy = vp[1] * x + vp[5] * y + vp[13]
    cw = vp[3] * x + vp[7] * y + vp[15]
    cx, cy = cx / cw, cy / cw
    left, top, width, height = m["rect"]
    css_x = left + (cx * 0.5 + 0.5) * width
    css_y = top + (0.5 - cy * 0.5) * height
    return round(css_x * m["dpr"]), round(css_y * m["dpr"])


def sample(img, m, x, y):
    px, py = to_pixel(m, x, y)
    if not (0 <= px < img.width and 0 <= py < img.height):
        return px, py, None, None
    r, g, b = img.getpixel((px, py))[:3]
    return px, py, (r, g, b), 0.2126 * r + 0.7152 * g + 0.0722 * b


def parse_point(s):
    x, y = s.split(",")
    return float(x), float(y)


def main(argv):
    if len(argv) < 4:
        print(__doc__)
        return 2
    img = Image.open(argv[1]).convert("RGB")
    with open(argv[2]) as f:
        m = json.load(f)
    points = []
    if argv[3] == "--line":
        a, b, n = argv[4].split(":")
        (x0, y0), (x1, y1), n = parse_point(a), parse_point(b), int(n)
        points = [(x0 + (x1 - x0) * i / max(n - 1, 1), y0 + (y1 - y0) * i / max(n - 1, 1)) for i in range(n)]
    else:
        points = [parse_point(p) for p in argv[3:]]
    for x, y in points:
        px, py, rgb, lum = sample(img, m, x, y)
        where = f"world ({x:7.2f}, {y:7.2f}) -> px ({px:5d}, {py:5d})"
        print(f"{where}  outside the screenshot" if rgb is None else f"{where}  rgb {rgb}  lum {lum:6.1f}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
