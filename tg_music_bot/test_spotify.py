import urllib.request
import re

url = "https://open.spotify.com/track/61bOHprZM29gfjF2F4ghF2"
req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
with urllib.request.urlopen(req) as response:
    html = response.read().decode('utf-8')
    match = re.search(r'<title>(.*?)</title>', html, re.IGNORECASE)
    if match:
        print(match.group(1))
