"""Bundle web/ into single-file builds.

dist/reefhue.html          full standalone page (open it directly, works offline)
dist/reefhue-artifact.html page body for claude.ai Artifacts (no <html>/<head>)

The ES modules are wrapped in functions and their imports rewired, and
engine.wasm is embedded as base64, so nothing is fetched at runtime
(apart from the Google Fonts stylesheet, which falls back to system fonts).
"""
import base64
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WEB = os.path.join(ROOT, "web")
DIST = os.path.join(ROOT, "dist")
MODULES = ["engine.js", "webm.js", "mp4.js", "gpu.js", "zip.js", "image.js", "pipeline.js", "demo.js", "tour.js", "app.js"]  # dependency order


def read(name):
    with open(os.path.join(WEB, name), encoding="utf-8") as f:
        return f.read()


def wrap_module(name, src):
    var = "__m_" + name[:-3]
    def imp(m):
        names, mod = m.group(1), m.group(2)
        return f"const {{{names}}} = __m_{mod};"
    src = re.sub(r"import\s*\{([^}]*)\}\s*from\s*'\./([\w-]+)\.js';", imp, src)
    exported = re.findall(r"^export\s+(?:async\s+)?(?:const|let|function|class)\s+(\w+)", src, re.M)
    src = re.sub(r"^export\s+", "", src, flags=re.M)
    assert "import " not in re.sub(r"import\(", "", src).replace("import.meta", ""), name
    return f"const {var} = (() => {{\n{src}\nreturn {{ {', '.join(exported)} }};\n}})();\n"


def main():
    os.makedirs(DIST, exist_ok=True)
    html = read("index.html")
    css = read("style.css")
    wasm = base64.b64encode(open(os.path.join(WEB, "engine.wasm"), "rb").read()).decode()
    js = "".join(wrap_module(m, read(m)) for m in MODULES)
    # demo.js dynamic import in tests only; app uses static imports
    js = js.replace("new URL('engine.wasm', import.meta.url)", "'engine.wasm'")
    scripts = f"<script>window.REEFHUE_WASM_B64 = \"{wasm}\";</script>\n<script type=\"module\">\n{js}</script>"

    head = re.search(r"<head>(.*?)</head>", html, re.S).group(1)
    body = re.search(r"<body>(.*?)</body>", html, re.S).group(1)
    body = re.sub(r'<script type="module" src="app.js"></script>', "", body)
    head_keep = "\n".join(
        l for l in head.strip().splitlines()
        if "charset" not in l and 'name="viewport"' not in l and "style.css" not in l
    )

    full = html.replace('<link rel="stylesheet" href="style.css">', f"<style>\n{css}</style>")
    full = full.replace('<script type="module" src="app.js"></script>', scripts)
    with open(os.path.join(DIST, "reefhue.html"), "w", encoding="utf-8") as f:
        f.write(full)

    title = re.search(r"<title>.*?</title>", head_keep).group(0)
    rest = head_keep.replace(title, "").strip()
    artifact = f"{title}\n{rest}\n<style>\n{css}</style>\n{body.strip()}\n{scripts}\n"
    with open(os.path.join(DIST, "reefhue-artifact.html"), "w", encoding="utf-8") as f:
        f.write(artifact)
    for n in ("reefhue.html", "reefhue-artifact.html"):
        print(n, os.path.getsize(os.path.join(DIST, n)), "bytes")


if __name__ == "__main__":
    main()
