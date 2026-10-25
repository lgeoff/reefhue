"""Test photos for the Android picker: JPEGs with and without GPS location in
EXIF (Android 10+ hands apps a location-stripped copy of photos that have it).
usage: make-photos.py <source.jpg> <out-dir>"""
import struct, sys, os

src, out = sys.argv[1], sys.argv[2]
os.makedirs(out, exist_ok=True)
jpeg = open(src, 'rb').read()
assert jpeg[:2] == b'\xff\xd8'

def strip_app1(j):
    p, o = 2, bytearray(j[:2])
    while p < len(j) and j[p] == 0xFF:
        m, ln = j[p + 1], struct.unpack('>H', j[p + 2:p + 4])[0]
        if m == 0xDA: break
        if m != 0xE1: o += j[p:p + 2 + ln]
        p += 2 + ln
    return bytes(o + j[p:])

def exif(gps, model=b'ReefCam\0'):
    # big-endian TIFF: IFD0 {Make, Model, Orientation, [GPS pointer]}, GPS IFD
    entries, data = [], b''
    n0 = 4 if gps else 3
    base = 8 + 2 + n0 * 12 + 4
    def add(tag, typ, count, value_bytes):
        nonlocal data
        if len(value_bytes) <= 4:
            entries.append(struct.pack('>HHI', tag, typ, count) + value_bytes.ljust(4, b'\0'))
        else:
            entries.append(struct.pack('>HHII', tag, typ, count, base + len(data)))
            data += value_bytes + (b'\0' if len(value_bytes) % 2 else b'')
    add(0x010F, 2, 7, b'Reefhu\0')
    add(0x0110, 2, len(model), model)
    add(0x0112, 3, 1, struct.pack('>HH', 1, 0))
    gps_at = None
    if gps:
        gps_at = len(entries)
        entries.append(None)
    ifd0_len = 2 + n0 * 12 + 4
    gps_off = base + len(data)
    if gps:
        rat = lambda *v: b''.join(struct.pack('>II', a, b) for a, b in v)
        g_entries, g_data = [], b''
        g_base = gps_off + 2 + 5 * 12 + 4
        def gadd(tag, typ, count, vb):
            nonlocal g_data
            if len(vb) <= 4: g_entries.append(struct.pack('>HHI', tag, typ, count) + vb.ljust(4, b'\0'))
            else: g_entries.append(struct.pack('>HHII', tag, typ, count, g_base + len(g_data))); g_data += vb
        gadd(0, 1, 4, bytes([2, 3, 0, 0]))
        gadd(1, 2, 2, b'N\0')
        gadd(2, 5, 3, rat((46, 1), (14, 1), (3000, 100)))  # Geneva
        gadd(3, 2, 2, b'E\0')
        gadd(4, 5, 3, rat((6, 1), (8, 1), (1500, 100)))
        gps_ifd = struct.pack('>H', 5) + b''.join(g_entries) + struct.pack('>I', 0) + g_data
        entries[gps_at] = struct.pack('>HHII', 0x8825, 4, 1, gps_off)
    else:
        gps_ifd = b''
    tiff = b'MM\0*' + struct.pack('>I', 8) + struct.pack('>H', n0) + b''.join(entries) + struct.pack('>I', 0) + data + gps_ifd
    body = b'Exif\0\0' + tiff
    return b'\xff\xe1' + struct.pack('>H', len(body) + 2) + body

plain = strip_app1(jpeg)
for i in range(1, 4):
    open(f'{out}/DIVE_GPS_{i}.jpg', 'wb').write(plain[:2] + exif(True) + plain[2:])
    open(f'{out}/DIVE_NOGPS_{i}.jpg', 'wb').write(plain[:2] + exif(False) + plain[2:])
print('photos in', out)
