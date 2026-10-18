#!/usr/bin/env python3
"""Generate build/icon.png — the Grungus app icon.

A flat indigo square (the app's accent color) with a white speech
bubble and three chat dots. Pure stdlib: 2x supersampled RGBA buffer
written out as a PNG via zlib (no imaging dependencies on this host).
"""
import struct
import zlib

SIZE = 512
SS = 2  # supersample factor
N = SIZE * SS

BG = (88, 101, 242, 255)      # #5865F2 — the app accent
WHITE = (255, 255, 255, 255)

# bubble geometry (512-space)
bx0, by0, bx1, by1 = 96, 96, 416, 336
R = 56
# tail: triangle dropping from the bubble's bottom edge
tail = [(150, by1 - 2), (150, 434), (246, by1 - 2)]
# three dots inside the bubble
dots = [(190, 216, 27), (256, 216, 27), (322, 216, 27)]


def inside_rounded_rect(x, y):
    """Center cross + four corner quarter-circles."""
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


rows = []
for py in range(N):
    row = bytearray()
    y = py / SS
    for px in range(N):
        x = px / SS
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
png += chunk(b"IHDR", struct.pack(">IIBBBBB", SIZE, SIZE, 8, 6, 0, 0, 0))
png += chunk(b"IDAT", zlib.compress(raw, 9))
png += chunk(b"IEND", b"")

with open("build/icon.png", "wb") as f:
    f.write(png)
print(f"wrote build/icon.png ({len(png)} bytes)")
