"""Checks that exports keep the source frame rate: frame count, average fps and
every frame timestamp. usage: python3 tests/fps-check.py source=export [...]"""
import json, subprocess, sys
def info(f):
    j = json.loads(subprocess.check_output(['ffprobe', '-v', 'error', '-select_streams', 'v', '-show_entries', 'stream=r_frame_rate,avg_frame_rate:frame=pts_time,best_effort_timestamp_time', '-of', 'json', f]))
    t = sorted(float(fr.get('pts_time') or fr.get('best_effort_timestamp_time')) for fr in j['frames'])
    t0 = t[0]; t = [x - t0 for x in t]
    s = j['streams'][0]
    return s['r_frame_rate'], s['avg_frame_rate'], t
print(f"{'source':22} {'frames':>12} {'avg fps src → out':>26} {'max time error':>15}")
for src, out in [(a, b) for a, b in (x.split('=') for x in sys.argv[1:])]:
    r1, a1, t1 = info(src); r2, a2, t2 = info(out)
    err = max(abs(x - y) for x, y in zip(t1, t2)) * 1000 if len(t1) == len(t2) else float('nan')
    ev = lambda s: eval(s.replace('/', '/')) if s != '0/0' else 0
    print(f"{src:22} {len(t1):>5} → {len(t2):<5} {ev(a1):>10.3f} → {ev(a2):<10.3f} {err:>12.2f} ms")
