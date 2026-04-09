# 🧊 3dcad

Browser-based **parametric 3D CAD** in the vein of desktop modelers — parts, a feature tree, and a live **Three.js** viewport — powered by **Open CASCADE** via [**replicad**](https://replicad.xyz/) and **opencascade.js**.

![3dcad — part viewport with feature tree](public/screenshot01.png)

## ✨ Stack

- **React 19** + **TypeScript** + **Vite**
- **@react-three/fiber** / **drei** + **Three.js** for the viewport
- **replicad** + **replicad-opencascadejs** for B-rep / solid modeling
- **Zustand** for state · **Tailwind CSS** for UI

## 🚀 Quick start

```bash
npm install
npm run dev
```

Then open the URL Vite prints (usually `http://localhost:5173`).

| Command        | Action              |
|----------------|---------------------|
| `npm run dev`  | Dev server + HMR    |
| `npm run build`| Typecheck + production build |
| `npm run preview` | Serve `dist` locally |
| `npm run lint` | ESLint              |

## 📁 Notes

- **`assemble2d`** is pulled from GitHub (`tab58/assemble2d`); ensure network access on first install.
- This is a **private** app (`"private": true` in `package.json`).

---

*Built with ⚡ Vite*
