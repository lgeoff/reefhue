"""Append ?v=<version> to every local module, stylesheet and wasm reference in a
built site folder, so phones never mix a fresh index.html with cached scripts.
Usage: python3 tools/cachebust.py _site <version>"""
import pathlib, re, sys

site, ver = pathlib.Path(sys.argv[1]), sys.argv[2]
q = f'?v={ver}'
for p in site.glob('*.js'):
    s = p.read_text()
    s = re.sub(r"""(from\s+|import\(\s*)(['"])(\./[\w.-]+\.js)\2""", lambda m: f'{m[1]}{m[2]}{m[3]}{q}{m[2]}', s)
    s = s.replace("new URL('engine.wasm', import.meta.url)", f"new URL('engine.wasm{q}', import.meta.url)")
    s = s.replace("new URL('./worker.js', import.meta.url)", f"new URL('./worker.js{q}', import.meta.url)")
    p.write_text(s)
idx = site / 'index.html'
s = idx.read_text()
s = s.replace('src="app.js"', f'src="app.js{q}"').replace('href="style.css"', f'href="style.css{q}"')
idx.write_text(s)
print('cache-busted', ver)
