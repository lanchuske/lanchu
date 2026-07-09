# Lanchu — Definición del proyecto

> Documento de definición. Describe **qué problema resuelve Lanchu, cuáles son las pocas
> cosas que hace muy bien, y por qué existe**. Es la base sobre la que se construye el
> resto del proyecto. El detalle técnico (tools, recursos, eventos, gobernanza) está en
> [`ARCHITECTURE.md`](./ARCHITECTURE.md).

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

Mientras tanto, cada agente se mantiene en su carril (límites de alcance con bloqueo
duro) y todo lo que hace es **visible y auditable**, para que —incluso sin ser técnico—
puedas *ver y confiar* en lo que hacen.

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
| **1. Onboarding sin fricción** | Un comando (`npx lanchu`) mete un agente en la org con un trabajo. Cero configuración. |
| **2. Agentes durables** | Persisten como miembros del equipo: reutilizar-o-crear al abrir sesión, y retiro seguro con handoff. **Este es el diferenciador.** |
| **3. Carril + visibilidad** | Cada agente acotado (bloqueo duro si se sale de rol), coordinado sin duplicar, y todo lo que hace visible (panel + audit). |

Todo lo demás —webhooks, funciones recurrentes, skills, backend remoto, paneles
sofisticados— es **deliberadamente "todavía no"** (ver §9). *Menos no es menos: es hacer
pocas cosas muy bien.*

---

## 4. Agentes durables (el corazón de Lanchu)

### Sesión ≠ Agente
- **Sesión** = una ventana de terminal, una conexión viva. Efímera.
- **Agente** = una identidad **durable** con un rol, su trabajo y su historial (su
  *huella*). Persiste aunque cierres la ventana.

```
   Agente "arregla-login"  (durable — vive en la org)
        ├── rol / alcance
        ├── tareas: #12 (en progreso), #15 (pendiente)
        ├── huella: áreas que tocó, contexto acumulado
        ├── historial / audit
        └── sesión actual: [ventana de terminal]  ← lo único efímero
```

### Ciclo de vida
```
   npx lanchu 'arregla el login'
        │
        ▼
   ¿hay un agente cuya huella coincide con este objetivo?
        ├── SÍ  → "un agente ya tocó login (idle, 2 tareas). ¿Reutilizar?"
        └── NO  → crear agente, asignar trabajo/rol
        │
        ▼
   ACTIVO  ◀──── sesión viva, trabajando
        │
   cierras la ventana
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
Cuando arrancas una sesión con un objetivo, Lanchu compara ese objetivo contra la
**huella** de los agentes existentes (qué tareas hicieron, qué áreas tocaron). Si hay
solape real, **te ofrece reutilizar** el agente que ya tiene ese contexto en lugar de
crear uno nuevo desde cero.

Por qué importa: reutilizar al agente con contexto es **más barato** (menos tokens
re-aprendiendo) y **evita duplicados**. Es coordinación y eficiencia a la vez.

### Retiro seguro
No puedes borrar un agente y dejar su trabajo huérfano. Al retirarlo, si tiene tareas
abiertas, Lanchu **bloquea el borrado** y te obliga a decidir **tarea por tarea**:
reasignar a otro agente o devolver al pool. Nada se pierde en silencio; el agente
retirado queda archivado en el audit.

---

## 5. Coordinación ≠ orquestación

Esta distinción define el proyecto:

- **Orquestación** = algo *decide el plan* y reparte ("tú haces esto, tú lo otro"). Es
  el cerebro director. **Lanchu NO es esto** — ese terreno está saturado (§6).
- **Coordinación** = los agentes **no chocan, no duplican y saben qué hacen los demás**.
  **Lanchu SÍ hace esto.**

Lanchu es **desopinado sobre el plan, estricto sobre los límites.** El plan lo pone quien
sea (un humano, los propios agentes, o un orquestador externo). Lanchu provee el sustrato
que hace ese trabajo concurrente **seguro, visible y acotado**.

### Coordinación *mediada*, no directa
Los agentes se coordinan **a través del estado compartido de Lanchu** (tareas, claims,
docs, eventos), **no hablándose directamente**. Es el patrón *blackboard*.

```
  ❌ Directa (peer-to-peer)          ✅ Mediada (a través de Lanchu)

   agentA ──mensaje──▶ agentB         agentA ──▶ ┌─────────┐ ◀── agentB
   → Lanchu NO lo ve                             │ Lanchu  │
   → NO gobernable                               └─────────┘
                                     agentA escribe → agentB lee
                                     Lanchu VE y PUEDE limitar todo
```

**El argumento decisivo:** si los agentes se coordinaran directamente, habría un canal
lateral que Lanchu no ve ni puede limitar → gobernanza ciega. Al forzar que **toda**
coordinación pase por Lanchu, cada acto es automáticamente **observable y limitable**.
La gobernanza no está peleada con la coordinación — **la exige mediada**.

---

## 6. Panorama competitivo (por qué Lanchu existe)

El espacio de "coordinación multi-agente" está **saturado**, y hay que ser honestos:

| Categoría | Ejemplos | Qué hacen | Para quién |
|-----------|----------|-----------|------------|
| **Orquestadores MCP** | Agent-MCP, amux | MCP con roles, tareas, locks, dashboard, memoria | Devs avanzados |
| **Orquestadores de código** | Conductor, Claude Squad, Vibe Kanban | Aíslan agentes en git worktrees para código en paralelo | Devs |
| **Frameworks** | LangGraph, CrewAI, AutoGen | Construir apps multi-agente en código | Devs |
| **Protocolos** | MCP (tools), A2A (agente↔agente) | Estándares de interoperabilidad | Plataformas |

**Agent-MCP** es casi idéntico a lo que podríamos haber construido, y su doc dice que es
*"para desarrolladores avanzados, con curva empinada por diseño"*.

**Dónde Lanchu es distinto (el wedge):** todos optimizan **orquestación para
desarrolladores**. Nadie trata a los agentes como **miembros durables** ni da
**control y confianza para quien supervisa** (que puede no ser técnico):

- **Se pone encima o al lado** de esos orquestadores, no compite con ellos.
- **El usuario estrella es el supervisor**, no el que escribe el plan.
- **Valor desde 1–3 agentes.** Un tablero de coordinación pura solo rinde a partir de
  ~20 agentes concurrentes; la gobernanza y la durabilidad dan valor con pocos agentes.

---

## 7. La solución

Lanchu es un **servidor MCP liviano** al que cada agente se conecta como un servicio
compartido. Expone primitivas de **ciclo de vida de agentes**, **coordinación mediada**
y **gobernanza**. El estado vive en un **servidor local con SQLite**, y un **panel web
liviano** lo muestra en tiempo real.

### Decisión de protocolo: MCP (no A2A)
- **MCP** es la capa agente↔servicio/herramientas: madura (18+ meses, 5.000+ servers) y
  **todo agente ya la habla**.
- **A2A** es la capa agente↔agente (delegar entre pares): real (v1.0, 2026) pero es
  *orquestación*, justo lo que Lanchu **no** es.
- Como Lanchu es un **servicio compartido** que cada agente consulta (no un canal entre
  agentes), **MCP es la capa correcta**. Forzar que la coordinación sea mediada por MCP
  es lo que **hace posible la gobernanza**. Si algún día hiciera falta delegación
  directa entre agentes, ahí se añadiría A2A.

### Restricciones no negociables

1. **100% local, sin servidor central.** Todo —estado, agentes, docs, panel— corre en
   la máquina del usuario. **Nada sale de ahí.** Esto no es solo técnico: es la historia
   de confianza que sostiene el posicionamiento (*"tus agentes y tu trabajo nunca salen
   de tu máquina"*).
2. **Cero telemetría phone-home.** Lanchu no envía nada a ningún lado. La única
   observabilidad del proyecto viene de fuentes externas que **ya existen** (ver
   *Telemetría* abajo).
3. **OS-agnóstico.** Corre igual en macOS, Linux y Windows. Se garantiza con: (a)
   `node:sqlite` (sin compilación nativa), (b) transporte `localhost` HTTP/SSE (no
   stdio, para compartir estado entre sesiones), (c) rutas vía `os`/`path`/`env-paths`,
   (d) el launcher **conecta** el agente, no gestiona su proceso.

### Telemetría (sin romper "todo local")

Lo que el maintainer necesita saber se obtiene **sin ningún servidor ni código de
telemetría**, consultando fuentes que ya recogen esos datos:

| Métrica | Fuente | ¿Servidor propio? |
|---|---|---|
| Descargas / adopción por versión | API de npm | ❌ no |
| Stars / forks | API de GitHub | ❌ no |
| PRs / issues / contributors | API de GitHub | ❌ no |

Las métricas de **uso en runtime** (cuántos agentes crea un usuario, tamaño de su org)
viven solo en su máquina y **deliberadamente no se recolectan** — serían imposibles sin
phone-home, que rompería la restricción #1.

---

## 8. Modelo de dominio

```
Organización
├── Documentación compartida (siempre actualizada)
├── Reglas / políticas (los límites de gobernanza)
├── Roles (definen alcance y permisos)
├── Agentes durables (miembros del equipo: activo / idle / retirado)
│   ├── rol + alcance
│   ├── huella (tareas hechas, áreas tocadas, contexto)
│   └── sesión actual (efímera)
└── Proyectos
    ├── Tareas (coordinación mediada + control de alcance + dueño)
    └── Audit log (trazabilidad inmutable: qué hizo, tocó y gastó)
```

---

## 9. Alcance del v0 (MVP)

El v0 son los **tres pilares** de §3, concretados:

1. **Onboarding sin fricción**
   `npx lanchu 'objetivo'` → el agente entra a la org, asume trabajo/rol y empieza.
2. **Agentes durables**
   Sesión ≠ agente; reutilizar-o-crear por objetivo; estados activo/idle/retirado;
   retiro seguro con handoff tarea-por-tarea.
3. **Carril + visibilidad**
   - Coordinación: tareas con claim atómico (no duplican).
   - Límites: bloqueo duro si algo es de otro o fuera de rol.
   - Visibilidad: panel en tiempo real + audit log inmutable.
   - **Documentación mínima**: leer/escribir la doc de la org, con registro de cambios.

**Decisiones técnicas del v0:**
- **Stack:** TypeScript + SDK oficial de MCP. Instalación con `npx lanchu`.
- **Protocolo:** MCP (§7).
- **Ejecución:** 100% local, sin servidor central, sin telemetría phone-home (§7).
- **Portabilidad:** OS-agnóstico (`node:sqlite` + `localhost` HTTP/SSE + rutas
  abstractas + launcher que conecta, no spawnea) (§7).
- **Estado:** servidor local + SQLite, con capa de almacenamiento abstracta para migrar
  a remoto más adelante.
- **Licencia:** MIT (open source).

---

## 10. Roadmap (deliberadamente fuera del v0)

- **Webhooks** — integración con sistemas externos (Slack, CI, GitHub).
- **Funciones recurrentes** — convertir una sesión útil en una función de negocio
  programada.
- **Skills** — capacidades reutilizables que los agentes pueden cargar.
- **Backend remoto** — organizaciones entre máquinas, con autenticación (necesario para
  "automatizar una empresa entera").
- **Límites avanzados** — presupuestos de tokens/coste por rol, cuotas, aprobaciones.
- **Interoperabilidad A2A** — si los agentes necesitan delegarse trabajo directamente.

---

## 11. Principios de diseño

1. **Pocas cosas, muy bien** — menos no es menos; es foco.
2. **Los agentes son miembros durables, no procesos de usar y tirar.**
3. **Gobernanza y coordinación son dos caras de lo mismo** — toda coordinación pasa por
   Lanchu, y por eso es gobernable.
4. **Desopinado sobre el plan, estricto sobre los límites.**
5. **El supervisor es de primera clase** — aunque no sea técnico, debe *ver y confiar*.
6. **Nada huérfano, nada en silencio** — reutilizar en vez de duplicar; retirar con
   handoff; todo en el audit.
7. **Todo local, nada sale de tu máquina** — sin servidor central, sin phone-home. La
   privacidad *es* parte de la confianza.
8. **OS-agnóstico** — corre igual en macOS, Linux y Windows.

---

## Fuentes del análisis competitivo

- [Agent-MCP (GitHub)](https://github.com/rinadelph/Agent-MCP)
- [9 Open-Source Agent Orchestrators (2026)](https://www.augmentcode.com/tools/open-source-agent-orchestrators)
- [AI Agent Orchestration in 2026 (amux)](https://amux.io/guides/ai-agent-orchestration-2026/)
- [MCP vs A2A (Atlan)](https://atlan.com/know/mcp/mcp-vs-a2a-protocol/)
- [A2A supera 150 orgs (Linux Foundation)](https://www.linuxfoundation.org/press/a2a-protocol-surpasses-150-organizations-lands-in-major-cloud-platforms-and-sees-enterprise-production-use-in-first-year)
