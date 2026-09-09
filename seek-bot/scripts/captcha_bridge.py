"""One bounded click-solver attempt on an existing Node Patchright tab."""
import asyncio
import json
import sys

from patchright.async_api import async_playwright
from playwright_captcha import CaptchaType, ClickSolver, FrameworkType


async def solve(request):
    async with async_playwright() as pw:
        browser = await pw.chromium.connect_over_cdp(request["endpoint"])
        # Select by CDP target ID, since several tabs may have the same URL.
        for context in browser.contexts:
            for page in context.pages:
                session = await context.new_cdp_session(page)
                try:
                    info = await session.send("Target.getTargetInfo")
                finally:
                    await session.detach()
                if info["targetInfo"]["targetId"] != request["targetId"]:
                    continue
                if page.url != request["url"]:
                    raise RuntimeError("Target navigated before solving")
                async with ClickSolver(
                    framework=FrameworkType.PATCHRIGHT, page=page, max_attempts=1
                ) as solver:
                    await solver.solve_captcha(
                        captcha_container=page,
                        captcha_type=getattr(CaptchaType, request["captchaType"]),
                        wait_checkbox_attempts=3,
                        wait_checkbox_delay=2,
                        checkbox_click_attempts=1,
                    )
                return
        raise RuntimeError("Target tab was not found")
    # Exiting async_playwright disconnects the driver; never close the shared browser.


if __name__ == "__main__":
    try:
        request = json.loads(sys.stdin.readline())
        asyncio.run(asyncio.wait_for(solve(request), timeout=45))
        print(json.dumps({"ok": True}))
    except Exception as error:
        print(json.dumps({"ok": False, "error": type(error).__name__}))
        sys.exit(1)
