# PersonPeek 🔍👤

It acts like a **dictionary extension, but for people**, pulling real-time biographical summaries, photos, news, and structured facts from Wikipedia, Wikidata, and Google News.

---

## Features

- **Instant Lookup**: Double-click or highlight any person's name on a webpage to show their info card.
- **Glassmorphic UI**: Premium dark glassmorphic card (frosted blur effect, purple/teal accents) designed to blend beautifully with any webpage.
- **Intelligent Default Positioning**: Appears in the top-right corner of the window (typically empty margin space) so it doesn't obstruct reading flow.
- **Draggable & Sticky**: Easily drag the details card anywhere using your mouse. The card stays pinned on scroll and page navigation until closed.
- **Remembers Position**: The card remembers its last dragged position for future lookups on the same webpage.
- **Toolbar Search Popup**: Click the extension icon in the toolbar to run manual searches, view recent search history, or configure active options.

---

## Installation Guide

Follow these steps to install and run the extension on your system (Chrome, Brave, Edge, or any Chromium-based browser):

### Prerequisites
You need **Node.js** and **npm** installed on your system to compile the TypeScript source files.
- Download and install them from [Node.js Official Website](https://nodejs.org/).

### 1. Clone the Repository
Clone this repository to your local machine:
```bash
git clone https://github.com/amarsinghpatil/personpeek-extension.git
cd personpeek-extension
```

### 2. Install Dependencies
Install the developer tools (TypeScript compiler and Chrome extension typings) required for the build process:
```bash
npm install
```

### 3. Compile and Build
Build the extension. This compiles the TypeScript files and copies the manifest, icons, HTML, and CSS files into the output folder (`dist/`):
```bash
# For Windows PowerShell / CMD:
npm run build

# If your system blocks script execution policies, run:
npm.cmd run build
```

### 4. Load the Unpacked Extension in Your Browser
1. Open your browser and navigate to the extensions settings page:
   - **Brave**: `brave://extensions`
   - **Chrome**: `chrome://extensions`
   - **Edge**: `edge://extensions`
2. Enable **Developer mode** (toggle switch in the top-right corner).
3. Click the **Load unpacked** button in the top-left corner.
4. Select the **`dist`** folder located inside your cloned project directory:
   ```text
   path/to/personpeek-extension/dist
   ```
5. The PersonPeek icon will appear in your browser toolbar! 🎉

---

## How to Use

1. **Direct Highlight**: Double-click or select/highlight a person's name (e.g., "Albert Einstein") on any website.
2. **Details Card**: The info card will slide open in the top-right corner showing their photo, birth/death dates, nationality, occupation, and a short bio.
3. **Repositioning**: Click and hold the header area of the card to drag it to any empty spot on the screen.
4. **Close**: Click the **✕** close button or press the **Escape** key to dismiss the card.
5. **Manual Search**: Click the extension icon in your toolbar, type a name, and press Enter to search manually.

---

## Technical Details Under the Hood

- **TypeScript**: Written entirely in TypeScript for type safety.
- **Shadow DOM**: Uses a closed Shadow DOM context to completely isolate the extension's CSS styles from the host webpages, preventing conflicts.
- **Background Service Worker**: Handles all API communications concurrently to avoid CORS policies and page limits.
- **APIs Used**: Wikipedia OpenSearch & REST Summary APIs (narrative and photos), Wikidata Claim parsing (structured facts like birth dates, occupations), and Google News RSS.

---

## Author

Created and maintained by **Amarsingh Patil**.

## License

This project is licensed under the [MIT License](LICENSE) - see the [LICENSE](LICENSE) file for details.
