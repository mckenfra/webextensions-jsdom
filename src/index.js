const fs = require('fs');
const path = require('path');
const jsdom = require('jsdom');
const sinon = require('sinon');
const {WebExtensionsApiFake} = require('webextensions-api-fake');
const nyc = require('./nyc');

class WebExtensionsJSDOM {
  constructor(options = {}) {
    this.webExtensionsApiFake = new WebExtensionsApiFake(options);
    this.webExtension = {
      destroy: async () => {
        if (this.webExtension.background) {
          await this.webExtension.background.destroy();
        }
        if (this.webExtension.popup) {
          await this.webExtension.popup.destroy();
        }
        if (this.webExtension.sidebar) {
          await this.webExtension.sidebar.destroy();
        }
        delete this.webExtension;
      }
    };
    this.sinon = options.sinon || sinon;
    this.wiring = options.wiring || false;

    this.nyc = new nyc;
  }

  async buildDom(options = {}, scripts = false) {
    const virtualConsole = new jsdom.VirtualConsole;
    virtualConsole.sendTo(console);
    virtualConsole.on('jsdomError', (error) => {
      // eslint-disable-next-line no-console
      console.error(error.stack, error.detail);
    });
    const jsdomOptions = Object.assign({
      virtualConsole
    }, options);
    jsdomOptions.resources = 'usable';
    jsdomOptions.beforeParse = (window) => {
      this.stubWindowApis(window);
      if (options.beforeParse) {
        options.beforeParse(window);
      }
    };

    let dom;
    if (!this.nyc.running) {
      jsdomOptions.runScripts = 'dangerously';
      if (!scripts) {
        dom = await jsdom.JSDOM.fromFile(options.path, jsdomOptions);
      } else {
        dom = new jsdom.JSDOM(this.htmlTemplate(scripts), jsdomOptions);
      }
    } else {
      dom = await this.nyc.buildDom(options, scripts, jsdomOptions);
    }

    if (dom.window.document.readyState !== 'complete') {
      await new Promise(resolve => {
        // https://developer.mozilla.org/en-US/docs/Web/API/Document/readyState
        // wait until "load" event because that indicates "complete"
        // "readystatechange" doesn't seem to fire with jsdom
        // nor is the readystatechange function called, so we do that
        dom.window.addEventListener('load', () => {
          const readystatechangeEvent = new dom.window.Event('readystatechange');
          dom.window.document.dispatchEvent(readystatechangeEvent);
          if (typeof dom.window.document.onreadystatechange === 'function') {
            dom.window.document.onreadystatechange();
          }
          resolve();
        });
      });
    }

    await this.nextTick();
    return dom;
  }

  htmlTemplate(scripts = []) {
    const scriptTags = scripts.map(script => {
      return `<script src="${script}"></script>`;
    }).join('');
    return `<!DOCTYPE html><html><head></head><body>${scriptTags}</body></html>`;
  }

  async buildBackground(background, manifestPath, options = {}) {
    const browser = this.webExtensionsApiFake.createBrowser();
    const that = this;

    const buildDomOptions = Object.assign({}, options.jsdom, {
      beforeParse(window) {
        window.browser = browser;
        window.chrome = browser;
        if (options.apiFake) {
          that.webExtensionsApiFake.fakeApi(window.browser);
        }

        if (options.jsdom && options.jsdom.beforeParse) {
          options.jsdom.beforeParse(window);
        }
      }
    });

    let dom;
    if (background.page) {
      const backgroundPath = path.resolve(manifestPath, background.page);
      buildDomOptions.path = backgroundPath;
      dom = await this.buildDom(buildDomOptions);
    } else if (background.scripts) {
      const scripts = [];
      for (const script of background.scripts) {
        scripts.push(path.resolve(path.join(manifestPath, script)));
      }
      dom = await this.buildDom(buildDomOptions, scripts);
    }

    this.webExtension.background = {
      browser,
      chrome: browser,
      dom,
      window: dom.window,
      document: dom.window.document,
      destroy: async () => {
        await this.nyc.writeCoverage(dom.window);
        dom.window.close();
        delete this.webExtension.background;
      }
    };
    if (options && options.afterBuild) {
      await options.afterBuild(this.webExtension.background);
    }
    return this.webExtension.background;
  }

  async buildPopup(popupPath, options = {}) {
    const browser = this.webExtensionsApiFake.createBrowser();
    const that = this;

    const dom = await this.buildDom(Object.assign({}, options.jsdom, {
      path: popupPath,
      beforeParse(window) {
        window.browser = browser;
        window.chrome = browser;
        if (options.apiFake) {
          that.webExtensionsApiFake.fakeApi(window.browser);
        }

        if (that.webExtension.background && that.wiring) {
          window.browser.runtime.sendMessage.callsFake(function() {
            const [result] = that.webExtension.background.browser.runtime.onMessage.addListener.yield(...arguments);
            return result;
          });
        }

        if (options.jsdom && options.jsdom.beforeParse) {
          options.jsdom.beforeParse(window);
        }
      }
    }));
    const helper = {
      clickElementById: async (id) => {
        dom.window.document.getElementById(id).click();
        await this.nextTick();
      },
      clickElementByQuerySelectorAll: async (querySelector, position = 'last') => {
        const nodeArray = Array.from(dom.window.document.querySelectorAll(querySelector));
        switch (position) {
        case 'last':
          nodeArray.pop().click();
          break;
        }
        await this.nextTick();
      }
    };
    this.webExtension.popup = {
      browser,
      chrome: browser,
      dom,
      window: dom.window,
      document: dom.window.document,
      helper,
      destroy: async () => {
        await this.nyc.writeCoverage(dom.window);
        dom.window.close();
        delete this.webExtension.popup;
      }
    };
    if (options && options.afterBuild) {
      await options.afterBuild(this.webExtension.popup);
    }
    return this.webExtension.popup;
  }

  async buildSidebar(sidebarPath, options = {}) {
    const browser = this.webExtensionsApiFake.createBrowser();
    const that = this;

    const dom = await this.buildDom(Object.assign({}, options.jsdom, {
      path: sidebarPath,
      beforeParse(window) {
        window.browser = browser;
        window.chrome = browser;
        if (options.apiFake) {
          that.webExtensionsApiFake.fakeApi(window.browser);
        }

        if (that.webExtension.background && that.wiring) {
          window.browser.runtime.sendMessage.callsFake(function() {
            const [result] = that.webExtension.background.browser.runtime.onMessage.addListener.yield(...arguments);
            return result;
          });
        }

        if (options.jsdom && options.jsdom.beforeParse) {
          options.jsdom.beforeParse(window);
        }
      }
    }));
    const helper = {
      clickElementById: async (id) => {
        dom.window.document.getElementById(id).click();
        await this.nextTick();
      },
      clickElementByQuerySelectorAll: async (querySelector, position = 'last') => {
        const nodeArray = Array.from(dom.window.document.querySelectorAll(querySelector));
        switch (position) {
        case 'last':
          nodeArray.pop().click();
          break;
        }
        await this.nextTick();
      }
    };
    this.webExtension.sidebar = {
      browser,
      chrome: browser,
      dom,
      window: dom.window,
      document: dom.window.document,
      helper,
      destroy: async () => {
        await this.nyc.writeCoverage(dom.window);
        dom.window.close();
        delete this.webExtension.sidebar;
      }
    };
    if (options && options.afterBuild) {
      await options.afterBuild(this.webExtension.sidebar);
    }
    return this.webExtension.sidebar;
  }

  stubWindowApis(window) {
    window.fetch = this.sinon.stub().resolves({
      json: this.sinon.stub().resolves({})
    });
  }

  nextTick() {
    return new Promise(resolve => {
      setTimeout(() => {
        process.nextTick(resolve);
      });
    });
  }
}

const fromManifest = async (manifestFilePath, options = {}) => {
  const webExtensionJSDOM = new WebExtensionsJSDOM(options);
  const manifestPath = path.dirname(manifestFilePath);
  const manifest = JSON.parse(fs.readFileSync(manifestFilePath));

  const webExtension = webExtensionJSDOM.webExtension;
  webExtension.webExtensionJSDOM = webExtensionJSDOM;

  if ((typeof options.background === 'undefined' || options.background) &&
      manifest.background &&
      (manifest.background.page || manifest.background.scripts)) {
    if (typeof options.background !== 'object') {
      options.background = {};
    }
    if (typeof options.apiFake !== 'undefined') {
      options.background.apiFake = options.apiFake;
    }
    await webExtensionJSDOM.buildBackground(manifest.background, manifestPath, options.background);
  }

  if ((typeof options.popup === 'undefined' || options.popup) &&
      manifest.browser_action && manifest.browser_action.default_popup) {
    const popupPath = path.resolve(manifestPath, manifest.browser_action.default_popup);
    if (typeof options.popup !== 'object') {
      options.popup = {};
    }
    if (typeof options.apiFake !== 'undefined') {
      options.popup.apiFake = options.apiFake;
    }
    await webExtensionJSDOM.buildPopup(popupPath, options.popup);
  }

  if ((typeof options.sidebar === 'undefined' || options.sidebar) &&
      manifest.sidebar_action && manifest.sidebar_action.default_panel) {
    const sidebarPath = path.resolve(manifestPath, manifest.sidebar_action.default_panel);
    if (typeof options.sidebar !== 'object') {
      options.sidebar = {};
    }
    if (typeof options.apiFake !== 'undefined') {
      options.sidebar.apiFake = options.apiFake;
    }
    await webExtensionJSDOM.buildSidebar(sidebarPath, options.sidebar);
  }

  return webExtension;
};

module.exports = {
  fromManifest,
  WebExtensionsJSDOM
};
