# quick: run engine on a JPEG, save before|after strip; prints auto params
import sys, os, json, subprocess, tempfile, numpy as np
from skimage import io
ROOT=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
src=sys.argv[1]; preset=sys.argv[2] if len(sys.argv)>2 else 'auto'; outp=sys.argv[3]
img=io.imread(src)[..., :3]; h,w,_=img.shape
rgba=np.concatenate([img, np.full((h,w,1),255,np.uint8)],2)
d=tempfile.mkdtemp(); a=os.path.join(d,'a'); b=os.path.join(d,'b'); m=os.path.join(d,'m')
rgba.tofile(a)
subprocess.run(['node', os.path.join(ROOT,'tests','run_engine.mjs'), a, str(w), str(h), b, preset, m], check=True)
out=np.fromfile(b,np.uint8).reshape(h,w,4)[...,:3]
mm=json.load(open(m)); au=mm['auto']
print('kred %.3f wg %.2f kblue %.3f gains %s black %s white %s' % (au[1],au[2],au[3], np.round(au[4:7],2), np.round(au[7:10],2), np.round(au[10:13],2)))
print('cast %.1f -> %.1f  uciqe %.3f -> %.3f' % (mm['before']['cast'], mm['after']['cast'], mm['before']['uciqe'], mm['after']['uciqe']))
io.imsave(outp, np.concatenate([img,out],1), quality=85)
