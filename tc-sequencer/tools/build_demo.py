"""Bundle the extension + mock viewer into one self-contained demo page (dist/demo.html)
for publishing as a hosted page. Usage: python tools/build_demo.py  (needs npx esbuild)"""
import subprocess, re, pathlib
root = pathlib.Path(__file__).resolve().parent.parent
js = subprocess.run(["npx", "esbuild", "js/app.js", "--bundle", "--format=iife", "--target=es2020", "--minify"],
                    cwd=root, capture_output=True, text=True, check=True).stdout
css = (root / "css/app.css").read_text()
html = (root / "index.html").read_text()
body = html[html.index("<body>") + 6: html.index("</body>")]
body = re.sub(r'<script type="module" src="js/app.js"></script>', "", body)
page = f"""<title>MT_Sequencer</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Open+Sans:wght@400;600;700&display=swap">
<style>
{css}
</style>
{body}
<script>window.TC_SEQ_DEMO = true;</script>
<script>
{js.replace("</script", "<\\/script")}
</script>
"""
import base64
icon_uri = "data:image/png;base64," + base64.b64encode((root / "icon.png").read_bytes()).decode()
logo_uri = "data:image/png;base64," + base64.b64encode((root / "logo.png").read_bytes()).decode()
page = re.sub(r'src="logo\.png(\?v=[\w.-]+)?"', f'src="{logo_uri}"', page)
out = root / "dist"; out.mkdir(exist_ok=True)
(out / "demo.html").write_text(page)
print("wrote", out / "demo.html", len(page), "bytes")
