import base64
import io
import os
from PIL import Image

CREST_SRC = 'apps/web/public/brand/dosco-crest.png'
WEB_PUBLIC = 'apps/web/public'
BLUME_PUBLIC = 'apps/web/blume-public'

def main():
    im = Image.open(CREST_SRC).convert('RGBA')
    
    # 1. favicon.ico with all standard resolutions
    im.save(
        os.path.join(WEB_PUBLIC, 'favicon.ico'),
        format='ICO',
        sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
    )
    print('Wrote favicon.ico')
    
    # 2. favicon.png (64x64)
    im.resize((64, 64), Image.Resampling.LANCZOS).save(os.path.join(WEB_PUBLIC, 'favicon.png'), 'PNG')
    print('Wrote favicon.png')
    
    # 3. icon-light-32.png and icon-dark-32.png
    im.resize((32, 32), Image.Resampling.LANCZOS).save(os.path.join(WEB_PUBLIC, 'icon-light-32.png'), 'PNG')
    im.resize((32, 32), Image.Resampling.LANCZOS).save(os.path.join(WEB_PUBLIC, 'icon-dark-32.png'), 'PNG')
    print('Wrote icon-32s')
    
    # 4. apple-touch-icon.png (180x180)
    apple_icon = im.resize((180, 180), Image.Resampling.LANCZOS)
    apple_icon.save(os.path.join(WEB_PUBLIC, 'apple-touch-icon.png'), 'PNG')
    print('Wrote apple-touch-icon.png')
    
    # 5. icon-192.png and icon-512.png
    im.resize((192, 192), Image.Resampling.LANCZOS).save(os.path.join(WEB_PUBLIC, 'icon-192.png'), 'PNG')
    im.resize((512, 512), Image.Resampling.LANCZOS).save(os.path.join(WEB_PUBLIC, 'icon-512.png'), 'PNG')
    print('Wrote icon-192 and icon-512')
    
    # 6. icon-maskable-512.png (512x512 on #0c0c0c background with safe zone 410px)
    maskable = Image.new('RGBA', (512, 512), (12, 12, 12, 255))
    mark_410 = im.resize((410, 410), Image.Resampling.LANCZOS)
    maskable.paste(mark_410, (51, 51), mark_410)
    maskable.save(os.path.join(WEB_PUBLIC, 'icon-maskable-512.png'), 'PNG')
    print('Wrote icon-maskable-512.png')
    
    # 7. favicon.svg (256x256 embedded png)
    im_256 = im.resize((256, 256), Image.Resampling.LANCZOS)
    buf = io.BytesIO()
    im_256.save(buf, format='PNG')
    b64 = base64.b64encode(buf.getvalue()).decode('ascii')
    
    svg_content = f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256"><image width="256" height="256" href="data:image/png;base64,{b64}"/></svg>\n'
    
    with open(os.path.join(WEB_PUBLIC, 'favicon.svg'), 'w', encoding='utf-8') as f:
        f.write(svg_content)
    print('Wrote apps/web/public/favicon.svg')
    
    if os.path.exists(BLUME_PUBLIC):
        with open(os.path.join(BLUME_PUBLIC, 'favicon.svg'), 'w', encoding='utf-8') as f:
            f.write(svg_content)
        print('Wrote apps/web/blume-public/favicon.svg')

if __name__ == '__main__':
    main()
