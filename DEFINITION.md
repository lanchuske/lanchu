# Lanchu — Definición del proyecto

> Documento de definición. Describe **qué problema resuelve Lanchu, cuáles son las pocas
> cosas que hace muy bien, y por qué existe**. Es la base sobre la que se construye el
> resto del proyecto. El detalle técnico (tools, recursos, eventos, gobernanza) está en
> [`ARCHITECTURE.md`](./ARCHITECTURE.md). Las decisiones aún abiertas, en
> [`OPEN-QUESTIONS.md`](./OPEN-QUESTIONS.md).

---

## 1. Visión

**Lanchu es la capa de control y confianza para los agentes de IA que ya tienes
corriendo.**

Abres una terminal, ejecutas un comando, y ese agente **entra a tu organización, asume
un trabajo y se pone a trabajar** — como un miembro más del equipo. No es un proceso de
usar y tirar: **el agente es durable**. Cierras la ventana y el agente sigue existiendo,
con su rol, su trabajo y su historial. Cuando vuelves, Lanchu te ofrece **reutilizarlo**
en vez de crear duplicados; y cuando lo retiras, se asegura de que **nadie quede con
trabajo importante huérfano**.

Mientras tanto, cada agente se mantiene en su carril (límites **cooperativos y
auditables**) y todo lo que hace es **visible y trazable**, para que —incluso sin ser
técnico— puedas *ver y confiar* en lo que hacen.

---

## 2. El problema

Cuando pones varios agentes de IA a trabajar juntos, aparecen dos familias de dolor:

**Coordinación** — que no se estorben:
- 🔁 **Trabajo duplicado.** Dos agentes resuelven la misma tarea.
- 💥 **Conflictos.** Dos agentes tocan el mismo recurso a la vez.
- 🤷 **Trabajo a ciegas.** El agente B no sabe qué hizo A ni cuándo terminó.

**Gobernanza** — que no se salgan del carril y que puedas confiar:
- 🚧 **Sin límites de alcance.** Un agente empieza algo de otro, o fuera de su rol.
- 🗑️ **Agentes de usar y tirar.** Cada ventana crea un agente nuevo desde cero; se
  pierde el contexto y se acumulan duplicados.
- 📄 **Documentación que se pudre.** Nadie garantiza que refleje lo que se hizo.
- 👀 **Cero visibilidad y cero confianza.** No ves quién hizo qué ni en qué gastó.

La mayoría de las herramientas de hoy atacan solo la **coordinación**, y para
desarrolladores. Casi nadie trata a los agentes como **miembros durables de un equipo**
ni le da al supervisor **control y confianza**. Ese es el hueco de Lanchu.

---

## 3. Las pocas cosas que hacemos muy bien

Lanchu no intenta hacer de todo. Hace **tres cosas**, y las hace muy bien:

| Pilar | Qué significa hacerlo *muy bien* |
|-------|----------------------------------|
| **1. Onboarding sin fricción** | Un comando (`npx lanchu`) mete un agente en la org con un trabajo y un rol. Cero configuración. |
| **2. Agentes durables** | Persisten como miembros del equipo: reutilizar-o-crear al abrir sesión, y retiro seguro con handoff. **Este es el diferenciador.** |
| **3. Carril + visibilidad** | Cada agente acotado (límites cooperativos + auditados), coordinado sin duplicar, y todo lo que hace visible (panel + audit). |

Todo lo demás —webhooks, funciones recurrentes, skills, backend remoto, paneles
sofisticados— es **deliberadamente "todavía no"** (ver §10). *Menos no es menos: es hacer
pocas cosas muy bien.*

---

## 4. Agentes durables (el corazón de Lanchu)

### Sesión ≠ Agente
- **Sesión** = una ventana de terminal, una conexión viva. Efímera.
- **Agente** = una identidad **durable** con un rol, su trabajo y su historial (su
  *huella*). Persiste aunque cierres la ventana.

```
   Agente "arregla-login"  (durable — vive en la org)
        ├── rol / alcance (etiquetas permitidas)
        ├── tareas: #12 (en progreso), #15 (pendiente)
        ├── huella: áreas que tocó, contexto acumulado
        ├── historial / audit
        └── sesión actual: [ventana de terminal]  ← lo único efímero
```

### Del objetivo a las tareas
Escribes un **objetivo** (`npx lanchu 'arregla el login'`). A partir de ahí:

1. El launcher crea (o reutiliza) un agente y le asigna un **rol**.
2. **El agente descompone su objetivo en tareas** con `task.create` (cada tarea con sus
   etiquetas). *Lanchu no descompone por él* — solo le da la primitiva. Así el `t=0`
   deja de estar vacío: ya hay tareas sobre las que coordinar y aplicar límites.
3. El agente reclama las tareas que caen en su rol; las que no, quedan para otros roles.

> Esto es coherente con "desopinado sobre el plan": Lanchu **no impone** ni el plan ni la
> forma de descomponer. Quien decide el plan es el agente (o el humano), no un motor de
> Lanchu.

### Ciclo de vida
```
   npx lanchu 'arregla el login'
        │
        ▼
   ¿hay un agente cuya huella coincide con este objetivo?
        ├── SÍ  → "un agente ya tocó login (idle, 2 tareas). ¿Reutilizar?"
        └── NO  → crear agente, elegir rol, descomponer objetivo en tareas
        │
        ▼
   ACTIVO  ◀──── launcher vivo y conectado, trabajando
        │
   cierras la ventana (el launcher termina)
        ▼
   IDLE   ◀──── sigue vivo; conserva rol + tareas reservadas + contexto
        │
   lo retiras (delete)
        ▼
   ¿tiene tareas abiertas?
        ├── SÍ → BLOQUEA. Por cada tarea: reasignar a otro agente o soltar al pool.
        └── NO → RETIRADO (archivado; permanece en el audit)
```

### Reutilizar-o-crear (por objetivo)
Al arrancar con un objetivo, Lanchu compara ese objetivo contra la **huella** de los
agentes existentes. Si hay solape real, **te ofrece reutilizar** el agente que ya tiene
ese contexto en lugar de crear uno desde cero. Reutilizar es **más barato** (menos tokens
re-aprendiendo) y **evita duplicados**.

### Retiro seguro
No puedes borrar un agente y dejar su trabajo huérfano. Al retirarlo, si tiene tareas
abiertas, Lanchu **bloquea el borrado** y te obliga a decidir **tarea por tarea**:
reasignar a otro agente o devolver al pool. Nada se pierde en silencio.

---

## 5. Coordinación, roles y límites

### Coordinación ≠ orquestación
- **Orquestación** = un motor *decide el plan* y reparte. **Lanchu NO es esto** (§6).
- **Coordinación** = los agentes **no chocan, no duplican y saben qué hacen los demás**.
  **Lanchu SÍ hace esto.**

Lanchu es **desopinado sobre el plan, estricto sobre los límites.** El plan lo pone el
agente o el humano; Lanchu provee el sustrato que hace ese trabajo concurrente **seguro,
visible y acotado**.

### Coordinación *mediada*, no directa
Los agentes se coordinan **a través del estado compartido de Lanchu** (tareas, claims,
docs, eventos), **no hablándose directamente**. Es el patrón *blackboard*.

```
  ❌ Directa (peer-to-peer)          ✅ Mediada (a través de Lanchu)
   agentA ──mensaje──▶ agentB         agentA ──▶ [ Lanchu ] ◀── agentB
   → Lanchu NO lo ve                  agentA escribe → agentB lee
   → NO gobernable                    Lanchu VE y PUEDE limitar todo
```

Si los agentes se coordinaran directamente habría un canal lateral que Lanchu no ve ni
puede limitar → gobernanza ciega. Forzar que **toda** coordinación pase por Lanchu es lo
que la hace **observable y limitable**. La gobernanza no está peleada con la coordinación:
**la exige mediada.**

### Roles y alcance (el "carril")
- Un **rol** = un nombre + una lista de **etiquetas permitidas** (ej. `frontend → [ui,
  css, componentes]`). Lo define cada org (roles *custom*, no un set fijo).
- Una **tarea** lleva **etiquetas** (ej. `#3 [ui]`).
- **Regla de alcance:** un agente con rol *R* puede reclamar/crear una tarea *T* si las
  etiquetas de *T* están cubiertas por las etiquetas permitidas de *R*. Si no, la acción
  se rechaza. Un rol comodín (`*`) puede tocar todo (útil para un coordinador).

### Qué significa "límite" aquí (y qué no) — honestidad
Esto es central: **Lanchu no es un sandbox del sistema operativo.**

- Lanchu solo puede rechazar las acciones que **pasan por Lanchu** (reclamar/crear una
  tarea, escribir un doc). Ahí el bloqueo es real y duro.
- Lanchu **no puede impedir físicamente** que un agente edite un archivo o corra un
  comando por su cuenta, fuera de Lanchu.
- Por eso el carril es un **límite cooperativo y 100% auditable**: Lanchu bloquea lo
  mediado y **hace visible y registra todo** — permitido o rechazado. La confianza viene
  de *ver todo*, no de encarcelar el proceso.
- **No-goal:** Lanchu no persigue enforcement a nivel de SO (jaula de procesos/archivos).
  Eso sería enorme, específico por OS y rompería "liviano".

---

## 6. Panorama competitivo (por qué Lanchu existe)

El espacio de "coordinación multi-agente" está **saturado**, y hay que ser honestos:

| Categoría | Ejemplos | Qué hacen | Para quién |
|-----------|----------|-----------|------------|
| **Orquestadores MCP** | Agent-MCP, amux | MCP con roles, tareas, locks, dashboard, memoria | Devs avanzados |
| **Orquestadores de código** | Conductor, Claude Squad, Vibe Kanban | Aíslan agentes en git worktrees | Devs |
| **Frameworks** | LangGraph, CrewAI, AutoGen | Construir apps multi-agente en código | Devs |
| **Protocolos** | MCP (tools), A2A (agente↔agente) | Estándares de interoperabilidad | Plataformas |

**Agent-MCP** es casi idéntico a lo que podríamos haber construido, y su doc dice que es
*"para desarrolladores avanzados, con curva empinada por diseño"*.

**Dónde Lanchu es distinto (el wedge):** todos optimizan **orquestación para
desarrolladores**. Nadie trata a los agentes como **miembros durables** ni da **control y
confianza para quien supervisa**:

- **Se pone encima o al lado** de esos orquestadores, no compite con ellos.
- **El usuario estrella es el supervisor**, no el que escribe el plan.
- **Valor desde 1–3 agentes.** Un tablero de coordinación pura solo rinde a partir de
  ~20 agentes; la gobernanza y la durabilidad dan valor con pocos.

---

## 7. La solución

Lanchu es un **servidor MCP liviano** al que cada agente se conecta como un servicio
compartido. Expone primitivas de **ciclo de vida de agentes**, **coordinación mediada** y
**gobernanza**. El estado vive en un **servidor local con SQLite**, y un **panel web
liviano** lo muestra en tiempo real.

### Decisión de protocolo: MCP (no A2A)
- **MCP** es la capa agente↔servicio/herramientas: madura y **todo agente ya la habla**.
- **A2A** es la capa agente↔agente (delegar entre pares): es *orquestación*, justo lo que
  Lanchu **no** es.
- Como Lanchu es un **servicio compartido** que cada agente consulta, **MCP es la capa
  correcta**. Forzar que la coordinación sea mediada por MCP es lo que **hace posible la
  gobernanza**. Si algún día hiciera falta delegación directa, ahí se añadiría A2A.

### Restricciones no negociables
1. **100% local, sin servidor central.** Todo corre en la máquina del usuario. **Nada
   sale de ahí.** Es la historia de confianza que sostiene el posicionamiento.
2. **Cero telemetría phone-home.** Lanchu no envía nada. La observabilidad del proyecto
   sale de fuentes externas que ya existen (ver *Telemetría*).
3. **OS-agnóstico.** Corre igual en macOS, Linux y Windows: (a) `node:sqlite` (sin
   compilación nativa), (b) transporte `localhost` HTTP/SSE (para compartir estado entre
   sesiones), (c) rutas vía `os`/`path`/`env-paths`, (d) el launcher **conecta** el
   agente, no gestiona su proceso.

### Telemetría (sin romper "todo local")
| Métrica | Fuente | ¿Servidor propio? |
|---|---|---|
| Descargas / adopción por versión | API de npm | ❌ no |
| Stars / forks / PRs / issues | API de GitHub | ❌ no |

Las métricas de **uso en runtime** (agentes creados, tamaño de la org) viven solo en la
máquina del usuario y **deliberadamente no se recolectan** (romperían la restricción #1).

### Quién es quién en el v0 (honestidad de alcance)
- El **operador** (semi-técnico) monta: corre `npx`, conecta el cliente MCP del agente.
- El **supervisor** (puede no ser técnico) observa y confía vía el **panel**.
- El v0 **no** promete que un no-técnico puro monte todo solo; sí que **supervise** sin
  serlo. La automatización de una empresa entera (multi-máquina) es roadmap (§10).

---

## 8. Modelo de dominio

```
Organización
├── Documentación compartida (trazable)
├── Roles (nombre + etiquetas permitidas = los límites)
├── Agentes durables (activo / idle / retirado)
│   ├── rol + alcance
│   ├── huella (tareas hechas, áreas tocadas, contexto)
│   └── sesión actual (efímera, con token de identidad)
└── Proyectos
    ├── Tareas (estado + etiquetas + dueño + dependencias)
    └── Audit log (trazabilidad inmutable: qué hizo, tocó y gastó*)
```
*El coste/tokens es **autoreportado** por el agente (opcional): Lanchu no lo mide.

---

## 9. Alcance del v0 (MVP)

Los **tres pilares** de §3, concretados:

1. **Onboarding sin fricción**
   `npx lanchu 'objetivo'` → crea/reutiliza agente, elige rol, el agente descompone en
   tareas y empieza.
2. **Agentes durables**
   Sesión ≠ agente; reutilizar-o-crear por objetivo; estados activo/idle/retirado; retiro
   seguro con handoff tarea-por-tarea.
3. **Carril + visibilidad**
   - Coordinación: tareas con claim atómico (no duplican).
   - Límites: roles con etiquetas; rechazo de acciones mediadas fuera de rol; **todo
     auditado** (cooperativo, no sandbox del SO).
   - Visibilidad: panel en tiempo real + audit log inmutable.
   - **Documentación mínima**: leer/escribir la doc de la org, con registro de cambios.

**Decisiones técnicas del v0:**
- **Stack:** TypeScript + SDK oficial de MCP. Instalación con `npx lanchu`.
- **Protocolo:** MCP. **Transporte:** `localhost` HTTP/SSE.
- **Identidad:** el launcher emite un **token de sesión**; la presencia = launcher vivo;
  la actividad se deriva de las **tool-calls recientes** (no de un heartbeat que el agente
  deba recordar).
- **Ejecución:** 100% local, sin servidor central, sin telemetría phone-home.
- **Portabilidad:** OS-agnóstico (`node:sqlite` + rutas abstractas + launcher que conecta).
- **Estado:** SQLite con capa de almacenamiento abstracta para migrar a remoto luego.
- **Licencia:** MIT.

---

## 10. Roadmap (deliberadamente fuera del v0)

- **Webhooks** — integración con sistemas externos (Slack, CI, GitHub).
- **Funciones recurrentes** — convertir una sesión útil en una función programada.
- **Skills** — capacidades reutilizables que los agentes cargan.
- **Backend remoto** — organizaciones entre máquinas, con auth (para "automatizar una
  empresa entera").
- **Límites avanzados** — presupuestos de tokens/coste por rol, cuotas, aprobaciones.
- **Interoperabilidad A2A** — si los agentes necesitan delegarse trabajo directamente.

---

## 11. Principios de diseño

1. **Pocas cosas, muy bien** — menos no es menos; es foco.
2. **Los agentes son miembros durables, no procesos de usar y tirar.**
3. **Gobernanza y coordinación son dos caras de lo mismo** — todo pasa por Lanchu.
4. **Desopinado sobre el plan, estricto sobre los límites.**
5. **Límites cooperativos + auditables, no una jaula** — la confianza viene de *ver
   todo*, no de encarcelar el proceso.
6. **El supervisor es de primera clase** — aunque no sea técnico, debe *ver y confiar*.
7. **Nada huérfano, nada en silencio** — reutilizar en vez de duplicar; retirar con
   handoff; todo en el audit.
8. **Todo local, nada sale de tu máquina** — sin servidor central, sin phone-home.
9. **OS-agnóstico** — corre igual en macOS, Linux y Windows.

---

## Fuentes del análisis competitivo

- [Agent-MCP (GitHub)](https://github.com/rinadelph/Agent-MCP)
- [9 Open-Source Agent Orchestrators (2026)](https://www.augmentcode.com/tools/open-source-agent-orchestrators)
- [AI Agent Orchestration in 2026 (amux)](https://amux.io/guides/ai-agent-orchestration-2026/)
- [MCP vs A2A (Atlan)](https://atlan.com/know/mcp/mcp-vs-a2a-protocol/)
- [A2A supera 150 orgs (Linux Foundation)](https://www.linuxfoundation.org/press/a2a-protocol-surpasses-150-organizations-lands-in-major-cloud-platforms-and-sees-enterprise-production-use-in-first-year)
