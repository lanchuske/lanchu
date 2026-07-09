# Lanchu — Definición del proyecto

> Documento de definición. Describe **qué problema resuelve Lanchu, cuál es su lugar
> frente a la competencia, y por qué existe**. Es la base sobre la que se construye el
> resto del proyecto. Vive versionado en el repo y se actualiza a medida que el diseño
> evoluciona. El detalle técnico (tools, recursos, eventos, webhooks) está en
> [`ARCHITECTURE.md`](./ARCHITECTURE.md).

---

## 1. Visión

**Lanchu es la capa de control y confianza para los agentes de IA que ya tienes
corriendo.**

No los orquesta ni decide su plan. Les da un **sustrato compartido** para que se
coordinen sin chocar, les pone **límites de alcance** (bloqueo duro), mantiene las
**reglas y la documentación al día**, y le da a una persona —incluso no técnica— un
**panel en tiempo real + audit log** para *ver y confiar* en lo que los agentes hacen.

El objetivo final: que cualquiera pueda poner varios agentes a trabajar sobre un
objetivo común —construir una app, automatizar procesos de una empresa— **sabiendo en
todo momento qué hace cada uno y con la certeza de que ninguno se sale de su carril.**

---

## 2. El problema

Cuando pones varios agentes de IA a trabajar juntos, aparecen dos familias de dolor:

**Coordinación** — que no se estorben:
- 🔁 **Trabajo duplicado.** Dos agentes resuelven la misma tarea.
- 💥 **Conflictos.** Dos agentes tocan el mismo recurso a la vez.
- 🤷 **Trabajo a ciegas.** El agente B no sabe qué hizo A ni cuándo terminó.

**Gobernanza** — que no se salgan del carril y que puedas confiar:
- 🚧 **Sin límites de alcance.** Un agente empieza algo que le corresponde a otro, o
  fuera de su rol, sin darse cuenta.
- 📄 **Documentación que se pudre.** Nadie garantiza que el conocimiento compartido
  refleje lo que realmente se hizo.
- 👀 **Cero visibilidad y cero confianza.** No ves quién hizo qué, en qué gastó
  contexto/tokens, ni por qué. No puedes confiar en lo que no ves.

La mayoría de las herramientas de hoy atacan solo la **coordinación** (y para
desarrolladores). Casi nadie ataca la **gobernanza para el que supervisa**. Ese es el
hueco de Lanchu.

---

## 3. Coordinación ≠ orquestación (qué es y qué no es Lanchu)

Esta distinción define el proyecto:

- **Orquestación** = algo *decide el plan* y reparte trabajo ("tú haces esto, tú lo
  otro"). Es el cerebro director. **Lanchu NO es esto** — ese terreno está saturado
  (ver §5) y nos volvería un clon.
- **Coordinación** = los agentes **no chocan, no duplican y saben qué hacen los demás**.
  **Lanchu SÍ hace esto**, y es imprescindible.

Lanchu es **desopinado sobre el plan, estricto sobre los límites.** El plan lo pone
quien sea (un humano, los propios agentes, o un orquestador externo como Agent-MCP,
Conductor o CrewAI). Lanchu provee el sustrato que hace ese trabajo concurrente
**seguro, visible y acotado**.

### Coordinación *mediada*, no directa

Los agentes se coordinan **a través del estado compartido de Lanchu** (el tablero, los
claims, las docs, los eventos), **no hablándose directamente entre ellos**. Es el patrón
*blackboard* clásico.

```
  ❌ Directa (peer-to-peer)          ✅ Mediada (a través de Lanchu)

   agentA ──mensaje──▶ agentB         agentA ──▶ ┌─────────┐ ◀── agentB
   (se hablan entre sí)                          │ Lanchu  │
   → Lanchu NO lo ve                             │  board  │
   → NO gobernable                               │  docs   │
                                                 │ eventos │
                                                 └─────────┘
                                     agentA escribe → agentB lee
                                     Lanchu VE y PUEDE limitar todo
```

**Por qué esto es el corazón del diseño:** si los agentes se coordinaran directamente,
habría un canal lateral que Lanchu no ve ni puede limitar → gobernanza ciega. Al forzar
que **toda** coordinación pase por Lanchu, cada acto de coordinación es automáticamente
**observable y limitable**. Es decir: **la gobernanza no está peleada con la
coordinación — la exige mediada. Coordinar bien es parte de gobernar bien.**

---

## 4. Los desafíos

Lo que Lanchu tiene que resolver, expresado como preguntas:

| # | Desafío | Pregunta que debe responder |
|---|---------|-----------------------------|
| 1 | **Identidad y registro** | ¿Cómo se registra un agente a una org y asume un rol sin fricción al abrir la sesión? |
| 2 | **Límites de alcance** | ¿Cómo se garantiza —con bloqueo duro— que un agente solo toque lo que le corresponde? |
| 3 | **Coordinación mediada** | ¿Cómo se coordinan sin chocar ni duplicar, pasando todo por Lanchu? |
| 4 | **Estado compartido en vivo** | ¿Cómo ven todos —agentes y humano— una misma verdad en tiempo real? |
| 5 | **Documentación viva** | ¿Cómo se garantiza que la documentación compartida esté siempre actualizada? |
| 6 | **Confianza y trazabilidad** | ¿Cómo ve el supervisor qué hizo cada agente, qué tocó y qué gastó? |
| 7 | **Foco y eficiencia** | ¿Cómo ayudan las tools a que el agente se enfoque y optimice contexto/modelo? |
| 8 | **Recurrencia** | ¿Cómo convertir una sesión útil en una función de negocio que se repite? |
| 9 | **Simplicidad** | ¿Cómo mantener todo liviano e instalable con un solo comando? |

---

## 5. Panorama competitivo (por qué Lanchu existe)

El espacio de "coordinación multi-agente" está **saturado**, y hay que ser honestos al
respecto:

| Categoría | Ejemplos | Qué hacen | Para quién |
|-----------|----------|-----------|------------|
| **Orquestadores MCP** | Agent-MCP, amux | Servidor MCP con roles, tareas, locks, dashboard, memoria compartida | Devs avanzados |
| **Orquestadores de código** | Conductor, Claude Squad, Vibe Kanban, Crystal | Aíslan agentes en git worktrees para código en paralelo | Devs |
| **Frameworks** | LangGraph, CrewAI, AutoGen, Semantic Kernel | Construir apps multi-agente en código | Devs |
| **Protocolos** | MCP (tools), A2A (agente↔agente) | Estándares de interoperabilidad | Plataformas |

**Agent-MCP** es casi idéntico a lo que podríamos haber construido (roles, tareas,
locks, dashboard, SQLite). Su documentación dice explícitamente que es *"para
desarrolladores avanzados, con curva empinada por diseño"*.

**Dónde Lanchu es distinto (el wedge):** todos los anteriores optimizan
**orquestación para desarrolladores**. Casi nadie ataca **gobernanza y confianza para
quien supervisa** (que puede no ser técnico):

- **Se pone encima o al lado** de esos orquestadores, no compite con ellos. Puedes usar
  Conductor para lanzar agentes y Lanchu para *controlarlos y auditarlos*.
- **El usuario estrella es el supervisor**, no el que escribe el plan. Es el que quiere
  *ver y confiar*, poner límites, y saber que la documentación no miente.
- **Valor desde 1–3 agentes.** Un tablero de coordinación pura solo rinde a partir de
  ~20 agentes concurrentes (algo que casi nadie corre hoy). La gobernanza da valor
  incluso con pocos agentes: el valor es *"veo y confío en lo que hicieron"*.

---

## 6. La solución

Lanchu es un **servidor MCP liviano** al que cada agente se conecta como un servicio
compartido. Expone primitivas de **coordinación mediada** y **gobernanza**. El estado
vive en un **servidor local con SQLite**, y un **panel web liviano** lo muestra en
tiempo real.

### Cómo se resuelve cada desafío

- **Identidad / registro (1):** al iniciar sesión el agente se registra con su org,
  proyecto y rol. Lanchu le devuelve su identidad, su alcance y el contexto mínimo.
- **Límites de alcance (2):** antes de trabajar, el agente consulta si algo está en su
  alcance; si intenta reclamar algo tomado o fuera de su rol, la tool **falla con
  error** (bloqueo duro). El límite *es* el mecanismo de gobernanza.
- **Coordinación mediada (3):** tablero de tareas con estados y *locks* atómicos; nadie
  duplica ni se pisa. Toda coordinación pasa por Lanchu, así que es visible y acotable.
- **Estado compartido en vivo (4):** un único servidor mantiene la verdad; agentes y
  humano la ven al instante (recursos MCP suscribibles + panel).
- **Documentación viva (5):** la doc de la org vive en Lanchu; las tools empujan a
  leerla antes de actuar y actualizarla al terminar; cada cambio queda registrado.
- **Confianza y trazabilidad (6):** un *audit log* inmutable registra quién hizo qué,
  qué tocó y qué gastó. El panel se lo muestra al supervisor.
- **Foco y eficiencia (7):** las tools entregan solo el contexto relevante al rol/tarea.
- **Recurrencia (8):** una sesión útil se guarda como una **función recurrente**
  (roadmap) que se ejecuta de forma programada.
- **Simplicidad (9):** `npx lanchu` levanta servidor + panel.

### Decisión de protocolo: MCP (no A2A)

- **MCP** es la capa agente↔servicio/herramientas: madura (18+ meses, 5.000+ servers) y
  **todo agente ya la habla**.
- **A2A** es la capa agente↔agente (delegar entre pares/vendors): real (v1.0, 2026) pero
  es *orquestación*, justo lo que Lanchu **no** es.
- Como Lanchu es un **servicio compartido** que cada agente consulta (no un canal de
  mensajes entre agentes), **MCP es la capa correcta**, no un parche. Además, forzar que
  la coordinación sea mediada por MCP es lo que **hace posible la gobernanza**.
- Si algún día hiciera falta que los agentes *se deleguen trabajo entre sí*, ahí se
  añadiría A2A. El modelo de eventos se diseña para no cerrar esa puerta.

---

## 7. Modelo de dominio

```
Organización
├── Documentación compartida (siempre actualizada)
├── Reglas / políticas (los límites de gobernanza)
├── Roles (definen alcance y permisos)
├── Miembros = Agentes (sesiones que se registran y asumen un rol)
└── Proyectos
    ├── Tareas (coordinación mediada + control de alcance)
    ├── Ramas / actividad (qué hace cada agente ahora)
    └── Audit log (trazabilidad inmutable: qué hizo, tocó y gastó)
```

**Conceptos clave:**

- **Organización** — unidad de más alto nivel. Agrupa documentación, reglas, roles,
  agentes y proyectos. Puede haber varias.
- **Proyecto** — vive dentro de una org. Agrupa tareas, actividad y trazabilidad.
- **Rol** — define el alcance de un agente: qué puede reclamar y qué puede tocar. Es la
  unidad de gobernanza.
- **Agente / Sesión** — una sesión que se registró a una org y asumió un rol.
- **Tarea** — unidad de trabajo con estado, dueño y dependencias.
- **Documentación** — conocimiento compartido que se mantiene actualizado.
- **Audit log** — historial inmutable de todo lo que hacen los agentes.

---

## 8. Alcance del v0 (MVP)

El primer release es útil pero liviano. Incluye:

1. **Registro + roles + org/proyecto**
   Crear org y proyecto; el agente se registra al abrir sesión y asume un rol.
2. **Límites de alcance + coordinación mediada**
   Tareas con claim atómico (no duplican) y bloqueo duro cuando algo es de otro o fuera
   de rol.
3. **Panel en tiempo real + audit log**
   Ver agentes activos, qué hacen, y el historial de lo que hicieron.
4. **Documentación compartida + trazabilidad**
   Documentación de la org que los agentes leen/actualizan, con registro de cambios.

**Decisiones técnicas del v0:**

- **Stack:** TypeScript + SDK oficial de MCP. Instalación con `npx lanchu`.
- **Protocolo:** MCP (ver §6).
- **Estado:** servidor local + SQLite, con una capa de almacenamiento abstracta para
  poder migrar a un backend remoto más adelante.
- **Licencia:** MIT (open source).

---

## 9. Roadmap (fuera del v0)

- **Funciones recurrentes** — convertir una sesión en una función de negocio programada.
- **Skills** — capacidades reutilizables que los agentes pueden cargar.
- **Backend remoto** — organizaciones compartidas entre máquinas, con autenticación
  (necesario para el caso "automatizar una empresa entera").
- **Límites avanzados** — presupuestos de tokens/coste por rol, cuotas, aprobaciones.
- **Interoperabilidad A2A** — si los agentes necesitan delegarse trabajo directamente.

---

## 10. Principios de diseño

1. **Gobernanza y coordinación son dos caras de lo mismo** — toda coordinación pasa por
   Lanchu, y por eso es gobernable.
2. **Desopinado sobre el plan, estricto sobre los límites** — Lanchu no dirige; acota.
3. **El supervisor es de primera clase** — incluso si no es técnico, debe *ver y confiar*.
4. **La documentación es un ciudadano de primera clase** — siempre actualizada y trazable.
5. **Liviano y simple** — poca infra, `npx lanchu`, sin fricción de registro.
6. **Contribución controlada** — (a) gobernanza del repo open source; (b) políticas de
   alcance sobre qué puede tocar cada agente conectado.

---

## Fuentes del análisis competitivo

- [Agent-MCP (GitHub)](https://github.com/rinadelph/Agent-MCP)
- [9 Open-Source Agent Orchestrators (2026)](https://www.augmentcode.com/tools/open-source-agent-orchestrators)
- [AI Agent Orchestration in 2026 (amux)](https://amux.io/guides/ai-agent-orchestration-2026/)
- [MCP vs A2A (Atlan)](https://atlan.com/know/mcp/mcp-vs-a2a-protocol/)
- [A2A supera 150 orgs (Linux Foundation)](https://www.linuxfoundation.org/press/a2a-protocol-surpasses-150-organizations-lands-in-major-cloud-platforms-and-sees-enterprise-production-use-in-first-year)
