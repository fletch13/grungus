#!/usr/bin/env python3
"""Generate the Grungus app icon: build/icon.png (512x512) and
build/icon.ico (multi-size, PNG-embedded entries).

A flat indigo square (the app's accent color) with a white speech
bubble and three chat dots. Pure stdlib: a 2x supersampled RGBA buffer
per size, written as PNG via zlib — the .ico wraps PNG entries (valid
since Windows Vista; rcedit and electron-builder accept it). No
imaging dependencies, and deliberately no wine anywhere.
"""
import struct
import zlib

BASE = 512  # the geometry is defined in this space
SS = 2      # supersample factor
ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]

BG = (88, 101, 242, 255)      # #5865F2 — the app accent
WHITE = (255, 255, 255, 255)

# bubble geometry (BASE-space)
bx0, by0, bx1, by1 = 96, 96, 416, 336
R = 56
tail = [(150, by1 - 2), (150, 434), (246, by1 - 2)]
dots = [(190, 216, 27), (256, 216, 27), (322, 216, 27)]


def inside_rounded_rect(x, y):
    """Center cross + four corner quarter-circles (BASE-space coords)."""
    if not (bx0 <= x <= bx1 and by0 <= y <= by1):
        return False
    if bx0 + R <= x <= bx1 - R or by0 + R <= y <= by1 - R:
        return True
    cx = bx0 + R if x < bx0 + R else bx1 - R
    cy = by0 + R if y < by0 + R else by1 - R
    dx, dy = x - cx, y - cy
    return dx * dx + dy * dy <= R * R


def inside_tail(x, y):
    (ax, ay), (bx, by), (cx, cy) = tail
    d = (by - ay) * (cx - ax) - (bx - ax) * (cy - ay)
    if d == 0:
        return False
    w1 = ((x - ax) * (by - ay) + (y - ay) * (ax - bx)) / d
    w2 = ((x - ax) * (cy - ay) + (y - ay) * (bx - ax)) / d
    return w1 >= 0 and w2 >= 0 and w1 + w2 <= 1


def inside_dot(x, y):
    for cx, cy, r in dots:
        if (x - cx) ** 2 + (y - cy) ** 2 <= r * r:
            return True
    return False


def render_png(size):
    """Render the icon at `size` px, scaling the BASE-space geometry."""
    scale = size / BASE
    n = size * SS
    rows = []
    for py in range(n):
        row = bytearray()
        y = py / SS / scale  # back to BASE-space coordinates
        for px in range(n):
            x = px / SS / scale
            if inside_tail(x, y) or (inside_rounded_rect(x, y) and not inside_dot(x, y)):
                row.extend(WHITE)
            else:
                row.extend(BG)
        rows.append(bytes(row))
    raw = b"".join(b"\x00" + r for r in rows)

    def chunk(tag, data):
        out = struct.pack(">I", len(data)) + tag + data
        return out + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 9))
    png += chunk(b"IEND", b"")
    return png


def write_ico(path, sizes):
    """ICO with PNG-embedded entries, one per size (little-endian)."""
    images = [render_png(s) for s in sizes]
    count = len(sizes)
    header = struct.pack("<HHH", 0, 1, count)
    entries = b""
    offset = 6 + 16 * count
    for size, img in zip(sizes, images):
        dim = 0 if size >= 256 else size  # 0 means 256 in ICO
        entries += struct.pack("<BBBBHHII", dim, dim, 0, 0, 1, 32, len(img), offset)
        offset += len(img)
    data = header + entries + b"".join(images)
    with open(path, "wb") as f:
        f.write(data)
    print(f"wrote {path} ({len(data)} bytes, sizes {sizes})")


if __name__ == "__main__":
    png = render_png(512)
    with open("build/icon.png", "wb") as f:
        f.write(png)
    print(f"wrote build/icon.png ({len(png)} bytes)")
    write_ico("build/icon.ico", ICO_SIZES)
