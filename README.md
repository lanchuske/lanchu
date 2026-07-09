<h1 align="center">Lanchu</h1>

<p align="center">
  <b>El panel de control y los límites para los agentes de IA que ya tienes corriendo.</b><br>
  Coordínalos sin que se pisen. Míralos en tiempo real. Confía en lo que hacen.
</p>

---

## ¿Qué problema resuelve?

Cada vez más personas usan varios agentes de IA (como Claude o Cursor) para construir
aplicaciones o automatizar su empresa. Pero cuando pones **varios agentes a la vez**,
aparecen dos dolores:

**No se coordinan** — y se estorban:
- 🔁 **Se pisan el trabajo** — dos agentes hacen lo mismo.
- 🤷 **Trabajan a ciegas** — el uno no sabe qué hizo el otro.

**No los puedes controlar** — ni confiar:
- 🚧 **Se salen de su carril** — un agente toca algo que no le corresponde.
- 📄 **La documentación queda vieja** — nadie mantiene el conocimiento al día.
- 👀 **No ves nada** — no sabes quién hizo qué, ni en qué gastó.

La mayoría de las herramientas solo atacan la coordinación, y son para programadores.
**Lanchu añade lo que falta: control y confianza para quien supervisa.**

Lanchu **no orquesta** tus agentes (no decide su plan). Les da un **lugar de trabajo
común** para que se coordinen sin chocar, les pone **límites de alcance**, mantiene la
**documentación al día**, y te da un **panel + historial** para *ver y confiar* en lo
que hacen — aunque no seas técnico.

## Cómo funciona (la idea)

1. Lanzas tus agentes como siempre (con la herramienta que ya uses).
2. Cada agente **se registra en tu organización y asume un rol**.
3. A partir de ahí, solo trabaja en **lo que le corresponde**: toma tareas, lee la
   documentación compartida, y Lanchu **rechaza y registra** cualquier acción fuera de su
   carril. Los agentes se coordinan **a través de Lanchu**, no hablándose entre ellos —
   por eso tú lo ves y lo puedes acotar todo.
4. Tú miras el **panel en tiempo real**: quién está activo, en qué trabaja, qué
   documentación crea, y un **historial** de todo lo que hicieron.

> Lanchu pone **límites cooperativos y auditables**: bloquea lo que pasa por él y deja
> **todo a la vista**. No es una jaula del sistema — la confianza viene de *verlo todo*.

## Inicio rápido

```bash
npx lanchu
```

> ⚠️ El proyecto está en fase de definición. El comando anterior es la meta de
> instalación; todavía no está publicado. Mira [`DEFINITION.md`](./DEFINITION.md) para
> entender hacia dónde va.

## Qué incluye la primera versión

- **Organizaciones y proyectos** — agrupa a tus agentes y su trabajo.
- **Registro y roles** — cada agente sabe quién es y qué puede tocar.
- **Coordinación con control de alcance** — nadie duplica ni se pisa; las acciones fuera
  del rol se rechazan y quedan registradas.
- **Panel en tiempo real** — ves qué hace cada agente y en qué está.
- **Historial (audit log)** — todo lo que hicieron queda registrado, para que confíes.
- **Documentación compartida y trazable** — el conocimiento siempre al día.

Lo que viene después (funciones recurrentes, skills, organizaciones en la nube…) está en
el [roadmap](./DEFINITION.md#9-roadmap-fuera-del-v0).

## Para quién es

Para cualquiera que **supervise a varios agentes** trabajando sobre un objetivo común:
para construir una app, automatizar procesos o coordinar el trabajo de una empresa.
Lanchu se pone **encima o al lado** de las herramientas que ya uses para lanzar agentes.

En esta primera versión hay dos papeles: un **operador** (semi-técnico) que hace el
montaje inicial —correr un comando, conectar tus agentes—, y un **supervisor** que
observa y confía desde el panel, **sin necesidad de ser programador**.

## Contribuir

Lanchu es open source y las contribuciones son bienvenidas de forma controlada.
Empieza por leer la [definición del proyecto](./DEFINITION.md). (Guía de contribución
detallada próximamente.)

## Licencia

[MIT](./LICENSE)
