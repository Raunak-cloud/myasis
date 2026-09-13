"""Cut the recorded SEEK run into a short, privacy-safe website demo."""
from pathlib import Path
import subprocess
import imageio_ffmpeg

ROOT = Path(__file__).resolve().parents[2]
source = ROOT / "render_check" / "real-footage" / "full.webm"
output = ROOT / "dashboard" / "public" / "demo"
output.mkdir(parents=True, exist_ok=True)
ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()

# All clips are from the same uninterrupted real run. Public job-site context stays
# visible. Redaction is limited to the signed-in account marker, the applicant's
# cover-letter/profile content, and the applicant's name on confirmation.
filter_graph = r"""
[0:v]split=4[v0][v1][v2][v3];
[v0]trim=start=55:end=58,setpts=PTS-STARTPTS,scale=1280:800,drawbox=x=1035:y=10:w=52:h=52:color=#edf4fa:t=fill[s0];
[v1]trim=start=617:end=620.5,setpts=PTS-STARTPTS,scale=1280:800,drawbox=x=1035:y=10:w=52:h=52:color=#edf4fa:t=fill[s1];
[v2]trim=start=632:end=637,setpts=PTS-STARTPTS,scale=1280:800,split=7[application][letter][history][profilesummary1][contactcard][profilesummary2][confirmtop];
[letter]crop=650:430:195:0,boxblur=10:5[letterblur];
[history]crop=650:200:195:600,boxblur=10:5[historyblur];
[profilesummary1]crop=650:520:195:0,boxblur=10:5[profilesummary1blur];
[contactcard]crop=650:190:195:280,boxblur=10:5[contactcardblur];
[profilesummary2]crop=650:520:195:0,boxblur=10:5[profilesummary2blur];
[confirmtop]crop=110:42:655:70,boxblur=10:5[confirmtopblur];
[application][letterblur]overlay=195:0:enable='between(t\,0\,0.35)'[application0];
[application0][historyblur]overlay=195:600:enable='between(t\,0.3\,1.6)'[application1];
[application1][profilesummary1blur]overlay=195:0:enable='between(t\,1.55\,2.2)'[application2];
[application2][contactcardblur]overlay=195:280:enable='between(t\,2.15\,2.85)'[application3];
[application3][profilesummary2blur]overlay=195:0:enable='between(t\,2.75\,3.65)'[application4];
[application4][confirmtopblur]overlay=655:70:enable='between(t\,3.2\,5)'[s2];
[v3]trim=start=637:end=637.04,setpts=PTS-STARTPTS,scale=1280:800,loop=loop=86:size=1:start=0,setpts=N/25/TB,split=2[success][private];
[private]crop=110:42:655:168,boxblur=10:5[privateblur];
[success][privateblur]overlay=655:168[successprivate];
[successprivate]drawbox=x=1035:y=10:w=52:h=52:color=#edf4fa:t=fill[s3];
[s0][s1][s2][s3]concat=n=4:v=1:a=0,fps=25[out]
""".replace("\n", "")

movie = output / "myasis-live-run.mp4"
subprocess.run([
    ffmpeg, "-hide_banner", "-loglevel", "error", "-i", str(source),
    "-filter_complex", filter_graph, "-map", "[out]", "-an",
    "-c:v", "libx264", "-preset", "medium", "-crf", "22",
    "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-y", str(movie),
], check=True)

reader = imageio_ffmpeg.read_frames(str(movie))
metadata = next(reader)
reader.close()
duration = float(metadata.get("duration", 0))
if abs(duration - 15.0) > 0.05:
    raise RuntimeError(f"Expected a 15-second demo, encoded {duration:.3f} seconds")

subprocess.run([
    ffmpeg, "-hide_banner", "-loglevel", "error", "-ss", "1.2", "-i", str(movie),
    "-frames:v", "1", "-vf", "format=yuvj420p", "-q:v", "2", "-y",
    str(output / "myasis-live-run-poster.jpg"),
], check=True)

(output / "myasis-live-run.vtt").write_text("""WEBVTT

00:00.000 --> 00:03.000
Myasis searches and reviews available roles.

00:03.000 --> 00:06.500
It opens a suitable role.

00:06.500 --> 00:10.500
The application reaches final review with the selected resume and prepared cover letter.

00:10.500 --> 00:11.500
Myasis submits the application.

00:11.500 --> 00:15.000
The job site confirms the real application was sent.
""", encoding="utf-8")

print(f"{movie} ({duration:.2f}s)")
