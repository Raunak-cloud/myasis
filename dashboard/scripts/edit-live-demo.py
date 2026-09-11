"""Cut the recorded SEEK run into a short, privacy-safe website demo."""
from pathlib import Path
import subprocess
import imageio_ffmpeg

ROOT = Path(__file__).resolve().parents[2]
source = ROOT / "render_check" / "real-footage" / "full.webm"
output = ROOT / "dashboard" / "public" / "demo"
output.mkdir(parents=True, exist_ok=True)
ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()

# All clips are from the same uninterrupted real run. The long search is reduced
# to one results view, then the film jumps to the chosen listing, review, submit,
# and SEEK confirmation. The applicant's name in the success banner is blurred.
filter_graph = r"""
[0:v]split=4[v0][v1][v2][v3];
[v0]trim=start=55:end=58,setpts=PTS-STARTPTS,scale=1280:800[s0];
[v1]trim=start=617:end=620.5,setpts=PTS-STARTPTS,scale=1280:800[s1];
[v2]trim=start=632:end=636,setpts=PTS-STARTPTS,scale=1280:800[s2];
[v3]trim=start=636:end=640,setpts=PTS-STARTPTS,scale=1280:800,delogo=x=462:y=150:w=360:h=72:show=0[s3];
[s0][s1][s2][s3]concat=n=4:v=1:a=0[out]
""".replace("\n", "")

movie = output / "myasis-live-run.mp4"
subprocess.run([
    ffmpeg, "-hide_banner", "-loglevel", "error", "-i", str(source),
    "-filter_complex", filter_graph, "-map", "[out]", "-an",
    "-c:v", "libx264", "-preset", "medium", "-crf", "22",
    "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-y", str(movie),
], check=True)

subprocess.run([
    ffmpeg, "-hide_banner", "-loglevel", "error", "-ss", "1.2", "-i", str(movie),
    "-frames:v", "1", "-vf", "format=yuvj420p", "-q:v", "2", "-y",
    str(output / "myasis-live-run-poster.jpg"),
], check=True)

(output / "myasis-live-run.vtt").write_text("""WEBVTT

00:00.000 --> 00:03.000
Myasis searches SEEK and reviews available roles.

00:03.000 --> 00:06.500
It opens a suitable role: Casual Retail Sales Assistant at Mountain Warehouse.

00:06.500 --> 00:09.600
The application reaches final review with the selected résumé and prepared cover letter.

00:09.500 --> 00:10.000
Myasis submits the application.

00:10.000 --> 00:11.640
SEEK confirms the real application was sent to Mountain Warehouse.
""", encoding="utf-8")

print(movie)
