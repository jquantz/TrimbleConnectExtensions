"""Stamp a version on every file reference so browsers can't mix old and new files.
Usage: python tools/set_version.py 1.2.0   (run before every upload)"""
import re, sys, pathlib, json
v = sys.argv[1]
root = pathlib.Path(__file__).resolve().parent.parent
def stamp(path, pattern):
    p = root / path
    s = p.read_text()
    s2 = re.sub(pattern, lambda m: f'{m.group(1)}?v={v}{m.group(3)}', s)
    p.write_text(s2)
# local JS imports: "./x.js" / "./vendor/x.mjs"
for f in (root / "js").glob("*.js"):
    stamp(f"js/{f.name}", r'("\./[\w/.-]+?\.m?js)(\?v=[\w.-]+)?(")')
# index.html: css + entry script
stamp("index.html", r'((?:href|src)="(?:css/app\.css|js/app\.js|(?:icon|logo)\.png))(\?v=[\w.-]+)?(")')
# visible version label
app = root / "js/app.js"
s = app.read_text()
s = re.sub(r'const APP_VERSION = "[^"]*";', f'const APP_VERSION = "{v}";', s)
app.write_text(s)
pkg = root / "package.json"; d = json.loads(pkg.read_text()); d["version"] = v; pkg.write_text(json.dumps(d, indent=2) + "\n")
print("stamped", v)
