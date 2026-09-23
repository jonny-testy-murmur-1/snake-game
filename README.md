# Neon Snake

A retro 80s arcade snake game for the browser — synthwave sun, perspective
grid, CRT scanlines and a neon snake that glides rather than stutters.

Built with plain HTML, CSS and JavaScript. No build step, no dependencies.

## Play

Open `index.html` in a browser, or serve the folder:

```sh
python3 -m http.server 8000
# then visit http://localhost:8000
```

## Controls

| Action  | Keyboard                     | Touch              |
| ------- | ---------------------------- | ------------------ |
| Steer   | Arrow keys or `W` `A` `S` `D` | D-pad, or swipe    |
| Start   | `Space`, `Enter`, or any arrow | **Start Game**   |
| Pause   | `Space`                      | —                  |
| Restart | `R`                          | **Play Again**     |

## Rules

- Eat the magenta orbs for **10 points**. Every fourth orb is **golden** and
  worth **50**, but it expires — the ring around it counts down. Miss it and
  you keep your place in the rota: the next orb is golden instead.
- Every 5 orbs raises the level: the snake speeds up and changes colourway.
- Walls are lethal, and so is biting yourself.
- Fill every cell and you win the round outright — there is nowhere left to
  put an orb, so the grid bows out with a **PERFECT**.
- Your best score is kept in `localStorage`.

## Layout

| File         | Purpose                                                  |
| ------------ | -------------------------------------------------------- |
| `index.html` | Markup: backdrop layers, cabinet, HUD, overlay, controls |
| `styles.css` | Design tokens, synthwave scene, cabinet chrome, responsive |
| `game.js`    | Game loop, simulation, rendering, input, sound           |

## Notes on the implementation

- **Fixed timestep, interpolated rendering.** The simulation advances on a
  fixed accumulator; rendering lerps each segment between its previous and
  current cell, so movement is smooth at any frame rate without coupling the
  game speed to the display.
- **The snake is one stroked polyline**, not a row of squares — drawn in a
  glow pass, a gradient core and a specular highlight.
- **Sound is synthesised at runtime** with a few WebAudio oscillators, so
  there are no audio assets to ship. The context is created on first input,
  as autoplay policies require.
- **Turns are buffered** (up to two), so a quick double-tap around a corner
  isn't swallowed.
- Respects `prefers-reduced-motion`.
