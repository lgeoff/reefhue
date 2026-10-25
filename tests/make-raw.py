"""Synthetic RAW files with the layouts real cameras use (TIFF-based ARW/DNG
with a thumbnail, a large preview and sensor data; CR3-style ISO-BMFF; a
RAF-style header), plus one with no preview. usage: make-raw.py <dir with big.jpg, thumb.jpg>"""
import os, struct, sys
F = sys.argv[1]
big = open(f'{F}/big.jpg', 'rb').read(); thumb = open(f'{F}/thumb.jpg', 'rb').read()
sof3 = bytes([0xFF, 0xD8, 0xFF, 0xC3, 0, 11, 8, 0x0F, 0xA0, 0x17, 0x70, 1, 1, 0x11, 0]) + bytes([0xFF, 0xDA, 0, 8, 1, 1, 0, 0, 0, 0]) + os.urandom(20000) + b'\xff\xd9'
sensor = bytearray(os.urandom(400000))
for k in range(0, len(sensor), 50000): sensor[k:k + 3] = b'\xff\xd8\xff'
sensor = bytes(sensor) + sof3
def tiff_raw(orient):
    hdr = b'II*\x00' + struct.pack('<I', 8)
    n0 = 3; sub_off = 8 + 2 + n0 * 12 + 4; n1 = 2
    thumb_off = sub_off + 2 + n1 * 12 + 4; big_off = thumb_off + len(thumb)
    ifd0 = struct.pack('<H', n0) + struct.pack('<HHII', 0x112, 3, 1, orient) + struct.pack('<HHII', 0x14A, 4, 1, sub_off) + struct.pack('<HHII', 0x201, 4, 1, thumb_off) + struct.pack('<I', 0)
    sub = struct.pack('<H', n1) + struct.pack('<HHII', 0x201, 4, 1, big_off) + struct.pack('<HHII', 0x202, 4, 1, len(big)) + struct.pack('<I', 0)
    return hdr + ifd0 + sub + thumb + big + sensor
open(f'{F}/DSC09001.ARW', 'wb').write(tiff_raw(6))
open(f'{F}/DSC09002.DNG', 'wb').write(tiff_raw(1))
def box(t, b): return struct.pack('>I', 8 + len(b)) + t + b
open(f'{F}/IMG_0001.CR3', 'wb').write(box(b'ftyp', b'crx ' + struct.pack('>I', 1) + b'crx isom') + box(b'moov', box(b'uuid', b'\x85\xc0\xb6\x87\x82\x0f\x11\xe0\x81\x11\xf4\xce\x46\x2b\x6a\x48' + thumb)) + box(b'mdat', big + sensor))
app1 = bytes([0xff, 0xe1, 0, 0x22]) + b'Exif\0\0' + b'MM\0\x2a\0\0\0\x08' + bytes([0, 1, 1, 0x12, 0, 3, 0, 0, 0, 1, 0, 8, 0, 0, 0, 0, 0, 0])
open(f'{F}/DSCF0001.RAF', 'wb').write(b'FUJIFILMCCD-RAW 0201FF383501' + b'\0' * 72 + big[:2] + app1 + big[2:] + sensor)
open(f'{F}/broken.NEF', 'wb').write(b'MM\0*\0\0\0\x08' + b'\0' * 10 + sensor[:5000].replace(b'\xff\xd8\xff', b'\0\0\0'))
