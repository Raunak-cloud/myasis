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
# and confirmation. Branding, the page header, job title and applicant name are blurred.
filter_graph = r"""
[0:v]split=4[v0][v1][v2][v3];
[v0]trim=start=55:end=58,setpts=PTS-STARTPTS,scale=1280:800,split=3[search][seekbutton][searchquery];
[seekbutton]crop=96:52:1112:84,boxblur=10:5[seekbuttonblur];
[searchquery]crop=750:42:64:94,boxblur=10:5[searchqueryblur];
[search][seekbuttonblur]overlay=1112:84[searchbrand];
[searchbrand][searchqueryblur]overlay=64:94[s0];
[v1]trim=start=617:end=620.5,setpts=PTS-STARTPTS,scale=1280:800,split=3[listing][listingtitle][seekloader];
[listingtitle]crop=460:78:230:500,boxblur=12:6[listingtitleblur];
[seekloader]crop=140:70:570:640,boxblur=12:6[seekloaderblur];
[listing][listingtitleblur]overlay=230:500[listingredacted];
[listingredacted][seekloaderblur]overlay=570:640[s1];
[v2]trim=start=632:end=636,setpts=PTS-STARTPTS,scale=1280:800,split=6[application][applicationtitle][seekprofile][seeknotice][applicantdata][seekfooter];
[applicationtitle]crop=520:78:340:28,boxblur=12:6[applicationtitleblur];
[seekprofile]crop=250:52:545:218,boxblur=10:5[seekprofileblur];
[seeknotice]crop=650:50:205:286,boxblur=10:5[seeknoticeblur];
[applicantdata]crop=650:700:195:50,boxblur=20:10[applicantdatablur];
[seekfooter]crop=360:90:900:680,boxblur=12:6[seekfooterblur];
[application][applicationtitleblur]overlay=340:28[applicationpart];
[applicationpart][seekprofileblur]overlay=545:218[applicationredacted];
[applicationredacted][seeknoticeblur]overlay=205:286[applicationpublic];
[applicationpublic][applicantdatablur]overlay=195:50:enable='between(t\,0\,3.15)'[applicationprivate];
[applicationprivate][seekfooterblur]overlay=900:680[s2];
[v3]trim=start=637:end=637.04,setpts=PTS-STARTPTS,scale=1280:800,loop=loop=74:size=1:start=0,setpts=N/25/TB,split=2[success][private];
[private]crop=96:38:660:172,boxblur=9:4[blurred];
[success][blurred]overlay=660:172[s3];
[s0][s1][s2][s3]concat=n=4:v=1:a=0,split=2[film][header];
[header]crop=1280:66:0:0,boxblur=12:6[headerblur];
[film][headerblur]overlay=0:0,setpts=0.891*PTS,fps=25[out]
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
if abs(duration - 12.0) > 0.05:
    raise RuntimeError(f"Expected a 12-second demo, encoded {duration:.3f} seconds")

subprocess.run([
    ffmpeg, "-hide_banner", "-loglevel", "error", "-ss", "1.2", "-i", str(movie),
    "-frames:v", "1", "-vf", "format=yuvj420p", "-q:v", "2", "-y",
    str(output / "myasis-live-run-poster.jpg"),
], check=True)

(output / "myasis-live-run.vtt").write_text("""WEBVTT

00:00.000 --> 00:02.670
Myasis searches and reviews available roles.

00:02.670 --> 00:05.780
It opens a suitable role.

00:05.780 --> 00:08.570
The application reaches final review with the selected resume and prepared cover letter.

00:08.570 --> 00:09.150
Myasis submits the application.

00:09.150 --> 00:12.000
The job site confirms the real application was sent.
""", encoding="utf-8")

print(f"{movie} ({duration:.2f}s)")
