import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';

const script = readFileSync(fileURLToPath(new URL('./tg-threadbrief.user.js', import.meta.url)), 'utf8');
const openTabs: ReturnType<typeof vi.fn>[] = [];

function message(id: string, link = ''): string {
  return `<div class="Message has-views" data-message-id="${id}">
    <div class="message-action-buttons"><button aria-label="Forward"></button></div>
    ${link ? `<a href="${link}">post</a>` : ''}
  </div>`;
}

function setup(content: string): JSDOM {
  const dom = new JSDOM(`<!doctype html><html><head></head><body>
    <div id="MiddleColumn">
      <div class="ChatInfo"><div data-peer-id="-100123"></div></div>
      ${content}
    </div>
  </body></html>`, {
    pretendToBeVisual: true,
    runScripts: 'outside-only',
    url: 'https://web.telegram.org/a/#-100123',
  });
  const openTab = vi.fn();
  openTabs.push(openTab);
  Object.defineProperty(dom.window, 'GM_openInTab', { value: openTab });
  Object.defineProperty(dom.window, 'requestAnimationFrame', {
    value: (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    },
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, 'getBoundingClientRect', {
    value: () => ({ width: 100, height: 36, top: 0, right: 100, bottom: 36, left: 0, x: 0, y: 0, toJSON: () => ({}) }),
  });
  dom.window.eval(script);
  return dom;
}

async function flush(dom: JSDOM): Promise<void> {
  await new Promise((resolve) => dom.window.setTimeout(resolve, 20));
}

function close(dom: JSDOM): void {
  dom.window.dispatchEvent(new dom.window.Event('pagehide'));
  dom.window.close();
}

afterEach(() => {
  openTabs.splice(0).forEach((mock) => mock.mockReset());
});

describe('Telegram Web A userscript', () => {
  it('injects one button, handles lazy messages, and does not duplicate buttons', async () => {
    const dom = setup(message('42', 'https://t.me/example_channel/42'));
    await flush(dom);
    const middle = dom.window.document.getElementById('MiddleColumn')!;

    expect(middle.querySelectorAll('.threadbrief-summary-button')).toHaveLength(1);
    middle.append(dom.window.document.createRange().createContextualFragment(message('43', 'https://t.me/example_channel/43')));
    await flush(dom);
    expect(middle.querySelectorAll('.threadbrief-summary-button')).toHaveLength(2);

    middle.append(dom.window.document.createElement('span'));
    await flush(dom);
    expect(middle.querySelectorAll('.threadbrief-summary-button')).toHaveLength(2);
    close(dom);
  });

  it('opens the local project with the canonical public post URL', async () => {
    const dom = setup(message('42', 'https://t.me/Example_Channel/42?comment=9'));
    await flush(dom);
    const button = dom.window.document.querySelector<HTMLButtonElement>('.threadbrief-summary-button')!;

    button.click();
    await flush(dom);

    expect(openTabs[0]).toHaveBeenCalledWith(
      'http://127.0.0.1:5173/?telegram=https%3A%2F%2Ft.me%2Fexample_channel%2F42',
      { active: true, insert: true, setParent: true },
    );
    close(dom);
  });

  it('reads the public username from Channel Info and closes only the panel it opened', async () => {
    const dom = setup(message('42'));
    const chatInfo = dom.window.document.querySelector<HTMLElement>('.ChatInfo')!;
    chatInfo.addEventListener('click', () => {
      const panel = dom.window.document.createElement('aside');
      panel.id = 'channel-info';
      panel.innerHTML = `<h3>Channel Info</h3>
        <div role="button"><div class="multiline-item"><span class="title">https://t.me/example_channel</span></div></div>
        <button aria-label="Close">Close</button>`;
      panel.querySelector('button')!.addEventListener('click', () => panel.remove());
      dom.window.document.body.append(panel);
    });
    await flush(dom);

    dom.window.document.querySelector<HTMLButtonElement>('.threadbrief-summary-button')!.click();
    await flush(dom);

    expect(openTabs[0]).toHaveBeenCalledWith(
      'http://127.0.0.1:5173/?telegram=https%3A%2F%2Ft.me%2Fexample_channel%2F42',
      { active: true, insert: true, setParent: true },
    );
    expect(dom.window.document.getElementById('channel-info')).toBeNull();
    close(dom);
  });

  it('reads the username from localized channel info without Telegram internal classes', async () => {
    const dom = setup(message('42'));
    const chatInfo = dom.window.document.querySelector<HTMLElement>('.ChatInfo')!;
    chatInfo.addEventListener('click', () => {
      const panel = dom.window.document.createElement('aside');
      panel.id = 'channel-info';
      panel.innerHTML = `<h3>频道信息</h3>
        <a href="https://t.me/example_channel">@example_channel</a>
        <button aria-label="Close">Close</button>`;
      panel.querySelector('button')!.addEventListener('click', () => panel.remove());
      dom.window.document.body.append(panel);
    });
    await flush(dom);

    dom.window.document.querySelector<HTMLButtonElement>('.threadbrief-summary-button')!.click();
    await flush(dom);

    expect(openTabs[0]).toHaveBeenCalledWith(
      'http://127.0.0.1:5173/?telegram=https%3A%2F%2Ft.me%2Fexample_channel%2F42',
      { active: true, insert: true, setParent: true },
    );
    close(dom);
  });

  it('reads Telegram Web A channel usernames from the real RightColumn profile', async () => {
    const dom = setup(message('42'));
    const chatInfo = dom.window.document.querySelector<HTMLElement>('.ChatInfo')!;
    chatInfo.addEventListener('click', () => {
      const panel = dom.window.document.createElement('div');
      panel.id = 'RightColumn';
      panel.innerHTML = `<div class="RightHeader secondary">
        <button aria-label="Close" title="Close">Close</button>
        <h3 class="title">Channel Info</h3>
      </div>
      <div class="ListItem-button" role="button"><div class="multiline-item">
        <span class="title">https://t.me/example_channel</span><span class="subtitle">Link</span>
      </div></div>`;
      panel.querySelector('button')!.addEventListener('click', () => panel.remove());
      dom.window.document.body.append(panel);
    });
    await flush(dom);

    dom.window.document.querySelector<HTMLButtonElement>('.threadbrief-summary-button')!.click();
    await flush(dom);

    expect(openTabs[0]).toHaveBeenCalledWith(
      'http://127.0.0.1:5173/?telegram=https%3A%2F%2Ft.me%2Fexample_channel%2F42',
      { active: true, insert: true, setParent: true },
    );
    expect(dom.window.document.getElementById('RightColumn')).toBeNull();
    close(dom);
  });

  it('does not treat a t.me link inside another message as the current channel', async () => {
    const dom = setup(`${message('42')}<div class="Message" data-message-id="99">
      <div role="button">https://t.me/wrong_channel</div>
    </div>`);
    await flush(dom);

    dom.window.document.querySelector<HTMLButtonElement>('.threadbrief-summary-button')!.click();
    await new Promise((resolve) => dom.window.setTimeout(resolve, 2600));

    expect(openTabs[0]).not.toHaveBeenCalled();
    close(dom);
  }, 4000);

  it('keeps Channel Info open when it was already open', async () => {
    const dom = setup(`${message('42')}
      <aside id="channel-info"><h3>Channel Info</h3>
        <div role="button"><div class="multiline-item"><span class="title">https://t.me/example_channel</span></div></div>
        <button aria-label="Close">Close</button>
      </aside>`);
    await flush(dom);

    dom.window.document.querySelector<HTMLButtonElement>('.threadbrief-summary-button')!.click();
    await flush(dom);

    expect(openTabs[0]).toHaveBeenCalledOnce();
    expect(dom.window.document.getElementById('channel-info')).not.toBeNull();
    close(dom);
  });
});
