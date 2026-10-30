# Coinstep

A location game for phones in the spirit of Pokémon GO, with coins instead of creatures. Walk around the real world, catch bronze, silver and gold coins on a live map, and let your steps charge magnets and open chests. No build step and no backend: everything is saved on the phone.

## How to play

- **Catch coins**: walk until a coin is inside the gold circle (40 m), then tap it. Tap again when the marker crosses the bright arc. The brightest middle of the arc is a perfect strike, worth double.
- **Coins**: bronze is worth 1 and gives 3 tries, silver is worth 5 and gives 3 tries, gold is worth 25 and gives 2 tries. Miss every try and the coin rolls away.
- **Magnets**: every 250 steps charges one (3 at most). A magnet stretches your catch range to 100 m for 2 minutes.
- **Chests**: your steps fill the current chest. Bigger chests need more steps and pay better.
- **Daily rewards**: 2,000, 5,000 and 10,000 steps. Reaching 2,000 on consecutive days builds your streak.

Coins sit in the same spots for everyone and move every hour, so they work anywhere in the world without any map data. Coins and steps pause above about 30 km/h, so driving doesn't count.

## Running it on a phone

Phones only give a web page GPS and motion access on `https://`, so the folder has to be hosted. Any static host works, such as GitHub Pages or Netlify Drop. Open the link on the phone, tap **Start walking** and allow location and motion. To install it, use **Add to Home Screen** from the browser menu.

On a computer, serve the folder and use **Try the demo walk** to move with the arrow keys. Demo progress is saved separately from real walks.

## How steps are counted

Web pages can't read the phone's built-in step count (Apple Health or Google Fit). Coinstep counts steps itself from the accelerometer, and estimates them from GPS distance if the sensor isn't available. The screen shows which source is in use. Counting stops when the app is closed or in the background, so the app keeps the screen on while it is open. Counting steps all day would need a native app.

## Files

- `index.html`: the screens
- `style.css`: the look
- `world.js`: coin spawning, distances and the step detector
- `game.js`: GPS, sensors, the map, catching, rewards and saving
- `sw.js`, `manifest.webmanifest`, `icons/`: what makes it installable

## Tweaking the game

- Rarity and coin count: `coinsInCell()` in `world.js`
- Coin values, tries and difficulty: `COIN_TYPES` in `world.js`
- Catch range, magnets, daily rewards and chests: the constants at the top of `game.js`
- Step sensitivity: `StepDetector.PEAK_THRESHOLD` in `world.js`
