# Estilos visuales

Decididos el 12 de noviembre de 2026 a partir de maquetas de la página de colección.
La estructura de la app no cambia entre uno y otro; solo el acabado.

Maquetas de referencia (privadas): https://claude.ai/artifact/1TAqhNfoSQPannuzUYXKok
(1 = estilo elegido, 4 = alternativa guardada).

## Elegido: Técnico turquesa

Casi negro, líneas de un píxel, texto pequeño y preciso, un único acento turquesa.

| Papel | Valor |
| --- | --- |
| Fondo | `#08090a` |
| Panel / tarjeta | `#0f1011` |
| Línea y pestaña activa | `#1c1d20` |
| Texto | `#f7f8f8` |
| Texto secundario | `#8a8f98` |
| Acento | `#14b8a6` |
| Texto sobre acento | `#031412` |

- Tipografía: Inter. Texto base pequeño (11–12 px en la maqueta de 960 px), título 24 px, peso 600, interletraje −0,6 px.
- Barra superior baja (44 px) con una línea inferior de 1 px; sin fondo propio.
- Pestañas sin caja: la activa lleva fondo `#1c1d20` y radio 5 px.
- Botones con borde de 1 px y radio 6 px; el primario va relleno de acento.
- La barra de búsqueda y la de paginación no son cajas: solo líneas arriba y abajo, de lado a lado.
- Tarjetas con borde de 1 px, radio 8 px, fondo de panel. El estado va en gris y la nota en acento, sin fondo.
- Sin sombras, sin degradados, sin brillos.

## Alternativa guardada: Hormigón turquesa (negro)

Por si en el futuro se quiere cambiar. Señalética sobre hormigón: tipografía negra enorme
en mayúsculas, bloques rectos sin radio y el turquesa como único color.

| Papel | Valor |
| --- | --- |
| Fondo | `#060606` |
| Panel / tarjeta | `#101010` |
| Barra superior | `#000000` |
| Texto | `#c6c6c4` |
| Acento | `#14b8a6` |
| Texto sobre acento | `#031412` |
| Trazos sobre oscuro | `#ffffff22` (botones, paginación), `#ffffff12` (tarjetas) |
| Etiqueta de estado | fondo `#ffffff1a` |

- Tipografía de títulos y rótulos: Archivo Black, en mayúsculas. Título 50 px, interlineado 0,9, interletraje −2 px.
  Pestañas 12 px, nombres de tarjeta 13 px. El resto en Inter.
- Radio 0 en todo.
- Barra superior negra con un filo inferior de 4 px en acento.
- Pestañas como bloques pegados (sin separación); la activa rellena de acento.
- Botón secundario: fondo de panel con trazo interior de 2 px. Primario: relleno de acento.
- Barra de búsqueda: fondo de panel con una franja de 10 px de acento a la izquierda.
- Paginación: sin caja, con una línea inferior de 3 px.
- Tarjetas: fondo de panel, trazo interior de 1 px, texto alineado a la izquierda. La nota es un bloque de acento.
- Portadas apagadas: `filter: grayscale(.6) contrast(1.15) brightness(.92)`.
- Textura de fondo, dos tramas de puntos superpuestas:
  `radial-gradient(#00000040 1px, transparent 1.5px) 0 0 / 7px 7px` y
  `radial-gradient(#ffffff0a 1px, transparent 1.5px) 3px 4px / 11px 11px`.

CSS de la maqueta (las clases son las de la maqueta, no las de la app):

```css
.app { background: #060606; color: #c6c6c4; }
.nav { background: #000; border-bottom: 4px solid #14b8a6; }
.logo { font: 400 18px 'Archivo Black'; text-transform: uppercase; }
.tab { font: 400 12px 'Archivo Black'; text-transform: uppercase; padding: 8px 18px; background: #101010; }
.tab.on { background: #14b8a6; color: #031412; }
.eyebrow { font-weight: 700; color: #14b8a6; }
.h1 { font: 400 50px/0.9 'Archivo Black'; text-transform: uppercase; letter-spacing: -2px; }
.btn { background: #101010; box-shadow: inset 0 0 0 2px #ffffff22; text-transform: uppercase; font-size: 10px; letter-spacing: 1px; }
.btn.pri { background: #14b8a6; color: #031412; box-shadow: none; }
.bar { background: #101010; border-left: 10px solid #14b8a6; }
.pag { border-bottom: 3px solid #ffffff22; }
.card { background: #101010; box-shadow: inset 0 0 0 1px #ffffff12; }
.cov { filter: grayscale(.6) contrast(1.15) brightness(.92); }
.ct { font: 400 13px 'Archivo Black'; text-transform: uppercase; }
.st { background: #ffffff1a; }
.rt { background: #14b8a6; color: #031412; }
```
