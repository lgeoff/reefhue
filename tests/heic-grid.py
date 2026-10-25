# Builds a HEIF grid image from tile_0..5.mp4 (HEVC, 512x512): 3x2 grid, 1200x900, optional irot.
import struct, sys
out, rot = sys.argv[1], int(sys.argv[2])
def boxes(b, s, e):
    out=[]; p=s
    while p+8<=e:
        size,=struct.unpack('>I',b[p:p+4]); out.append((b[p+4:p+8],p+8,p+size)); p+=size
    return out
def find(b, path):
    s,e=0,len(b)
    for t in path:
        for bt,bs,be in boxes(b,s,e):
            if bt==t:
                s,e=bs,be
                if t==b'stsd': s+=8
                if t==b'hvc1': s+=78
                break
        else: return None
    return s,e
tiles=[]; hvcc=None
for i in range(6):
    b=open(f'tile_{i}.mp4','rb').read()
    s,e=find(b,[b'moov',b'trak',b'mdia',b'minf',b'stbl',b'stsd',b'hvc1',b'hvcC'])
    if hvcc is None: hvcc=b[s:e]
    ms,me=find(b,[b'mdat']); tiles.append(b[ms:me])
def box(t,*parts): body=b''.join(parts); return struct.pack('>I',8+len(body))+t+body
def full(t,v,f,*parts): return box(t,bytes([v])+f.to_bytes(3,'big'),*parts)
W,H=1200,900
ftyp=box(b'ftyp',b'heic',struct.pack('>I',0),b'mif1heic')
hdlr=full(b'hdlr',0,0,struct.pack('>I',0),b'pict',b'\0'*12,b'\0')
pitm=full(b'pitm',0,0,struct.pack('>H',1))
def infe(i,t): return full(b'infe',2,0,struct.pack('>HH',i,0),t,b'\0')
iinf=full(b'iinf',0,0,struct.pack('>H',7),infe(1,b'grid'),*[infe(2+k,b'hvc1') for k in range(6)])
iref=full(b'iref',0,0,box(b'dimg',struct.pack('>HH',1,6),*[struct.pack('>H',2+k) for k in range(6)]))
props=[box(b'hvcC',hvcc),full(b'ispe',0,0,struct.pack('>II',512,512)),full(b'ispe',0,0,struct.pack('>II',W,H))]
if rot: props.append(box(b'irot',bytes([rot])))
ipco=box(b'ipco',*props)
ent=struct.pack('>HB',1,2 if rot else 1)+bytes([3]+([4] if rot else []))
for k in range(6): ent+=struct.pack('>HB',2+k,2)+bytes([0x81,2])
iprp=box(b'iprp',ipco,full(b'ipma',0,0,struct.pack('>I',7),ent))
grid=bytes([0,0,1,2])+struct.pack('>HH',W,H)
idat=box(b'idat',grid)
def build(mdat_start):
    body=struct.pack('>BB',0x44,0x00)+struct.pack('>H',7)+struct.pack('>HHHH',1,1,0,1)+struct.pack('>II',0,len(grid))
    off=mdat_start
    for k in range(6): body+=struct.pack('>HHHH',2+k,0,0,1)+struct.pack('>II',off,len(tiles[k])); off+=len(tiles[k])
    return full(b'meta',0,0,hdlr,pitm,full(b'iloc',1,0,body),iinf,iref,iprp,idat)
meta=build(0); meta=build(len(ftyp)+len(meta)+8)
open(out,'wb').write(ftyp+meta+box(b'mdat',*tiles))
print('wrote', out)
