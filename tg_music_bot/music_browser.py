"""Chromium session for guest music players."""
from contextlib import contextmanager
import os
import shutil


@contextmanager
def music_browser(platform):
    from selenium import webdriver
    from selenium.webdriver.chrome.service import Service

    # These settings also identify Chromium on existing bot installations.
    binary = os.getenv('PUUK_VK_CHROMIUM_PATH') or shutil.which('chromium') or shutil.which('google-chrome')
    driver = os.getenv('PUUK_VK_CHROMEDRIVER_PATH') or shutil.which('chromedriver')
    if not binary or not driver:
        raise ValueError(f'На сервере недоступен гостевой браузер {platform}')
    options = webdriver.ChromeOptions()
    options.binary_location = binary
    options.page_load_strategy = 'eager'
    for flag in ('--headless', '--mute-audio', '--autoplay-policy=no-user-gesture-required'):
        options.add_argument(flag)
    options.set_capability('goog:loggingPrefs', {'performance': 'ALL'})
    with webdriver.Chrome(service=Service(driver), options=options) as browser:
        browser.set_page_load_timeout(22)
        browser.set_script_timeout(8)
        yield browser
