import { Marked, type Tokens } from "marked";

const sizes = new Map<string, { width: number; height: number }>();
const IMAGE = /!\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
const MAX_IMAGE_WIDTH = 600;

const escapeAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

export function createRenderer(assetBase: string) {
  const resolve = (href: string) =>
    /^([a-z][a-z0-9+.-]*:|\/\/|\/)/i.test(href) ? href : assetBase + href.replace(/^\.\//, "");

  const marked = new Marked({
    gfm: true,
    renderer: {
      // Image widths follow the markmap convention of putting the display width in the title.
      image({ href, title, text }: Tokens.Image) {
        const src = resolve(href);
        const natural = sizes.get(src);
        const width = Number(title) || Math.min(natural?.width ?? MAX_IMAGE_WIDTH, MAX_IMAGE_WIDTH);
        const height = natural ? Math.round((natural.height * width) / natural.width) : undefined;
        return `<img src="${escapeAttr(src)}" alt="${escapeAttr(text)}" width="${width}"${height ? ` height="${height}"` : ""}>`;
      },
    },
  });

  return {
    render(md: string): string {
      return marked.parse(md, { async: false }) as string;
    },

    /** Loads the natural size of every image so nodes can be measured before layout. */
    async preload(mds: string[]): Promise<void> {
      const srcs = new Set<string>();
      for (const md of mds) for (const m of md.matchAll(IMAGE)) srcs.add(resolve(m[1]));
      await Promise.all(
        [...srcs].filter(src => !sizes.has(src)).map(
          src =>
            new Promise<void>(done => {
              const img = new Image();
              img.onload = () => {
                sizes.set(src, { width: img.naturalWidth, height: img.naturalHeight });
                done();
              };
              img.onerror = () => done();
              img.src = src;
            }),
        ),
      );
    },
  };
}
