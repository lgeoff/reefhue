#!/bin/sh
# Sample files for tests/formats.mjs: transport streams, MKV, 3GP, AVI, TIFF
# variants, synthetic RAW layouts and a tiled, rotated HEIC.
# usage: tests/make-formats.sh <out-dir> <a JPEG photo>
set -e
OUT=$1; PHOTO=$2; HERE=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$OUT/heic" && cd "$OUT"
ff() { ffmpeg -hide_banner -loglevel error -y "$@"; }
ff -f lavfi -i "testsrc2=size=1920x1080:rate=25,format=yuv420p" -f lavfi -i "sine=frequency=440:sample_rate=48000" -t 6 -c:v libx264 -profile:v high -preset veryfast -g 12 -bf 2 -c:a ac3 -b:a 192k -ac 2 -f mpegts -mpegts_m2ts_mode 1 avchd_ac3.MTS
ff -f lavfi -i "testsrc2=size=1280x720:rate=30000/1001,format=yuv420p" -f lavfi -i "sine=frequency=330:sample_rate=48000" -t 5 -c:v libx264 -preset veryfast -g 30 -c:a aac -b:a 128k -f mpegts clip_aac.ts
ff -f lavfi -i "testsrc2=size=1920x1080:rate=25,format=yuv420p" -t 4 -c:v libx264 -preset veryfast -flags +ildct+ilme -x264-params interlaced=1:tff=1 -g 12 -f mpegts -mpegts_m2ts_mode 1 interlaced.m2ts
ff -f lavfi -i "testsrc2=size=1280x720:rate=30,format=yuv420p" -f lavfi -i "sine=frequency=500:sample_rate=44100" -t 4 -c:v libx264 -preset veryfast -c:a aac clip.mkv
ff -f lavfi -i "testsrc2=size=640x480:rate=30,format=yuv420p" -t 3 -c:v libx264 -preset veryfast -profile:v baseline -f 3gp clip.3gp
ff -f lavfi -i "testsrc2=size=640x480:rate=30" -t 2 -c:v mjpeg clip.avi
convert "$PHOTO" -strip -resize 3000x2000 -quality 90 big.jpg && convert big.jpg -resize 160x120 thumb.jpg
python3 "$HERE/make-raw.py" "$OUT"
convert big.jpg -compress lzw tiff8_lzw.tif
convert big.jpg -depth 16 -compress zip -define tiff:predictor=2 tiff16_zip.tif
convert big.jpg -compress rle tiff_packbits.tif
convert big.jpg -define tiff:tile-geometry=256x256 -compress lzw tiff_tiled.tif
convert big.jpg -interlace plane -compress none tiff_planar.tif
convert big.jpg -colorspace gray -compress lzw tiff_gray.tif
convert big.jpg -orient RightTop -compress none tiff_rot6.tif
convert big.jpg -alpha set -compress zip tiff_rgba.tif
convert big.jpg -depth 32 -define quantum:format=floating-point -compress none tiff_float.tif
convert big.jpg -compress jpeg tiff_jpeg.tif
cd heic
convert ../big.jpg -resize 1200x900^ -gravity center -extent 1200x900 src1200.png
convert src1200.png -background black -extent 1536x1024 -crop 512x512 +repage tile_%d.png
for i in 0 1 2 3 4 5; do ff -i tile_$i.png -vf "scale=out_range=tv,format=yuv420p" -c:v libx265 -x265-params log-level=error -frames:v 1 -tag:v hvc1 tile_$i.mp4; done
python3 "$HERE/heic-grid.py" grid_rot.heic 1 && python3 "$HERE/heic-grid.py" grid.heic 0
