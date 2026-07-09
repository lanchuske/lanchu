# Lanchu — Revisión pre-construcción (preguntas abiertas)

> Revisión crítica de [`DEFINITION.md`](./DEFINITION.md) y
> [`ARCHITECTURE.md`](./ARCHITECTURE.md) **antes de escribir código**. Lista los huecos,
> inconsistencias y decisiones pendientes. Nada de esto bloquea la *visión*; bloquea la
> *implementación*. Se resuelve y se cierra antes del v0.

Estado: 🔴 bloqueante · 🟡 importante · 🟢 menor / se puede fijar por defecto.
✅ = resuelto e integrado en DEFINITION/ARCHITECTURE.

---

## RESUELTAS (integradas en los documentos)

- **A1 ✅** — El agente descompone su objetivo en tareas con `task.create` (Lanchu no
  descompone; sigue desopinado). El objetivo deja de tener el `t=0` vacío.
- **A2 ✅** — Roles *custom* con etiquetas: `rol = {nombre, allowed_tags}`; tareas con
  `tags`; regla de alcance `T.tags ⊆ R.allowed_tags`. Rol `*` = comodín.
- **A3 ✅** — Enmarcado honesto: **límites cooperativos + auditables**. Bloqueo duro solo
  sobre acciones mediadas por Lanchu; sandbox del SO = **no-goal**.
- **A4 ✅** — Identidad por **token de sesión** del launcher; presencia = launcher vivo;
  actividad derivada de **tool-calls recientes** (no heartbeat del agente).
- **B1 ✅** — Eventos del ciclo de vida renombrados y alineados (`agent.created/reused/
  active/idle/retired`).
- **B2 ✅** — `branch` → `workspace` (genérico; git es un caso).
- **B3 ✅** — `tokens`/coste marcado como **autoreportado** (Lanchu no mide).
- **D1 ✅** — Explícito: *operador* semi-técnico monta; *supervisor* no-técnico observa.
- **D2 ✅** — Copy ajustado; "empresa entera" queda como roadmap (backend remoto).

---

## A. Huecos de fondo (RESUELTOS — ver arriba)

### A1. ✅ ¿Cómo se relacionan *objetivo*, *tarea* y *rol*?
El flujo es `npx lanchu 'arregla el login'`. Pero:
- Las **tareas** son la unidad de coordinación (claim, no-duplicar) y de alcance. Al
  escribir un objetivo, **todavía no hay ninguna tarea**. ¿El objetivo *se convierte* en
  una tarea? ¿El agente crea tareas con `task.create` a medida que trabaja? ¿El humano?
- Lanchu es *desopinado sobre el plan* (no descompone). Entonces, **¿quién crea las
  tareas** que luego se coordinan y se limitan?
- Sin resolver esto, "coordinación sin duplicar" y "bloqueo duro por alcance" no tienen
  sobre qué operar en `t=0`.

**Hay que definir:** la relación exacta objetivo → tarea(s) → rol, y quién las crea.

### A2. 🔴 ¿De dónde sale el *rol* de un agente, y cómo se expresa el *alcance*?
La gobernanza entera depende del rol, pero:
- En `npx lanchu 'arregla login'` **no se indica un rol**. ¿Cómo lo obtiene el agente?
  ¿Se infiere del objetivo? ¿Hay roles predefinidos? ¿Los define el usuario?
- El "bloqueo duro" dice "falla si la tarea está fuera de rol". Pero **¿cómo sabe Lanchu
  que una tarea pertenece a un rol?** Hace falta un modelo concreto: las tareas llevan
  etiquetas/áreas y los roles declaran qué pueden reclamar. Ese emparejamiento **no está
  definido**.

**Hay que definir:** el modelo de roles (predefinidos vs. custom), cómo se asigna al
lanzar, y la regla concreta rol ↔ tarea que hace real el bloqueo.

### A3. 🔴 Honestidad del "bloqueo duro": Lanchu **no** es un sandbox del SO
Esto es lo más importante de toda la revisión.
- Lanchu solo puede bloquear lo que **pasa por Lanchu** (reclamar una tarea, escribir un
  doc). **No puede impedir físicamente** que un agente edite un archivo, corra un comando
  o toque un recurso por su cuenta — el agente tiene sus propias herramientas fuera de
  Lanchu.
- Es decir: la gobernanza es **sobre las acciones mediadas**, no sobre el sistema
  operativo. El "carril" es un **acuerdo cooperativo** que Lanchu hace visible y
  registra, no una jaula.

**Hay que decidir:** cómo comunicamos esto con honestidad (¿"límites cooperativos +
auditables" en vez de "bloqueo duro" a secas?) y hasta dónde llega la promesa del v0.
Esto afecta al mensaje del README y a los principios.

### A4. 🔴 Identidad del agente y quién puebla la actividad "en tiempo real"
- Sobre `localhost` HTTP/SSE, **¿cómo sabe el servidor qué agente es cada conexión?**
  Hace falta un handshake (token de sesión que emite el launcher). Sin esto, cualquier
  proceso local puede suplantar a un agente.
- `session.heartbeat` como tool que el agente invoca es **poco fiable**: un LLM no llama
  a un heartbeat en un temporizador. La "actividad en tiempo real" probablemente deba
  derivarse de (a) la presencia del proceso launcher y (b) las llamadas a tools
  recientes — no de que el agente se acuerde de latir.

**Hay que definir:** el handshake de identidad (token local) y cómo se puebla realmente
el "qué está haciendo ahora" (launcher-wrapper vs. tool-calls del agente).

---

## B. Inconsistencias a corregir (puedo arreglarlas yo)

### B1. 🟡 Eventos del ciclo de vida no cuadran con el launcher
`§7` lista `agent.registered`, pero `§5` dice que **no hay `session.register`** (lo hace
el launcher). Y `agent.reused` aparece en eventos pero no se emite en ningún flujo
descrito. → Renombrar/alinear: `agent.created`, `agent.reused`, `agent.active`,
`agent.idle`, `agent.retired`, `agent.heartbeat`.

### B2. 🟡 `branch` está incrustado, pero el público no es solo código
`task.claim(branch?)`, `heartbeat(branch?)` y `data.branch` asumen git. Pero "automatizar
una empresa" incluye trabajo que no es código. → Generalizar a `workspace`/`contexto`
(con `branch` como caso particular opcional), para no atarnos a git.

### B3. 🟢 `tokens`/`coste` en audit y eventos es **autoreportado**
Lanchu no mide tokens; los reporta el agente (opcional). Hay que decirlo explícito para
no prometer una métrica que quizá no llegue.

---

## C. Specs que faltan antes de construir

### C1. 🔴 Modelo de datos / esquema (SQLite)
No existe todavía. Entidades: `org`, `project`, `role`, `agent`, `session`, `task`,
`doc`, `event`/`audit`. Campos, relaciones, índices, y el **enum de estados de tarea**
(`available → claimed → in_progress → blocked → done` + reservada por agente idle).

### C2. 🟡 Superficie de comandos de la CLI
Solo tenemos `npx lanchu 'objetivo'`. Faltan: `lanchu ls` (agentes/tareas),
`lanchu retire <agente>`, `lanchu stats` (vista local), `lanchu serve`/panel, selección
de **org/proyecto** (¿por `cwd`? ¿flag? ¿config?).

### C3. 🟡 Cómo se configura el cliente del agente para hablar con el servidor MCP
El agente (Claude Code, Cursor…) necesita saber la URL del servidor MCP local. ¿El
launcher lo inyecta? ¿Config del cliente? Es parte del "onboarding sin fricción".

### C4. 🟡 Política de agentes idle "zombies"
Un agente idle conserva sus tareas reservadas y **bloquea a los demás**. Si nunca vuelve,
esas tareas quedan atascadas hasta un retiro manual. → ¿Timeout/marca de "stale" que las
libere o avise?

### C5. 🟡 "Documentación siempre actualizada": mecanismo, no promesa
Hoy solo hay `doc.update`. "Siempre actualizada" no se cumple solo por existir la tool. →
¿Un *nudge* (al cerrar una tarea, recordar actualizar el doc afectado)? ¿O bajamos la
promesa a "fácil de actualizar y trazable"?

### C6. 🟢 Panel: puerto, arranque y acceso
¿Lo arranca el servidor? ¿Puerto fijo/configurable? Al ser local monousuario, sin auth;
conviene dejarlo escrito.

---

## D. Tensiones de alcance / posicionamiento (honestidad)

### D1. 🟡 ¿Quién es el "usuario" real del v0?
El mensaje dice "para no técnicos". Pero alguien **semi-técnico** todavía tiene que:
correr `npx`, configurar el cliente MCP del agente, tener agentes instalados. El **no
técnico puro** solo usa el **panel** (ver y confiar). → Conviene ser explícito: en el v0,
un *operador* semi-técnico monta; el *supervisor* no técnico observa. No prometer que un
no técnico monta todo solo… todavía.

### D2. 🟢 "Automatizar una empresa entera" vs. local monomáquina
La visión insinúa escala de empresa, pero el v0 es local de una máquina. Ya está como
roadmap (backend remoto), pero el copy debería no sobreprometer.

---

## Orden sugerido para cerrar

1. Resolver **A1–A4** (bloqueantes de fondo) — cambian el diseño.
2. Yo aplico **B1–B3** (inconsistencias) y **D1–D2** (matices de copy).
3. Escribir **C1** (esquema de datos) y **C2–C3** (CLI + config del cliente).
4. Fijar por defecto **C4–C6**.
5. Recién entonces: scaffold del v0.
