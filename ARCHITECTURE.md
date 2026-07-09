# Lanchu — Arquitectura

> Diseño concreto de la superficie MCP: **tools**, **recursos**, **eventos**,
> **gobernanza** y **webhooks**. Complementa [`DEFINITION.md`](./DEFINITION.md), que
> cubre el problema, el posicionamiento y el porqué. Este documento responde:
> *¿cómo se coordinan y se gobiernan los agentes, exactamente?*

---

## 1. Modelo: coordinación mediada + gobernanza

Todo pasa por Lanchu. Los agentes **no se hablan entre sí**; se coordinan a través del
**estado compartido** (patrón *blackboard*). Cada acción muta el estado y **emite un
evento**. Ese mismo stream alimenta a **tres consumidores**:

```
                          ┌─────────────────────────┐
   Agentes (MCP tools) ──▶│      Lanchu core        │
                          │  estado (SQLite)        │
                          │  + reglas/límites        │
                          │  + audit log            │
                          │  + event bus            │
                          └───────────┬─────────────┘
                                      │  cada acción emite un evento
                    ┌─────────────────┼──────────────────────┐
                    ▼                 ▼                      ▼
            1) Panel/Dashboard   2) Notificaciones MCP    3) Webhooks
             (SSE al navegador)   (resource.updated →     (POST → sistemas
              el supervisor ve)    el agente re-lee)        externos)
```

- **Empujar cambios:** el agente llama tools (`task.claim`, `task.update`, `doc.update`…).
- **Recibir coordinación:** el agente se **suscribe a recursos MCP**; cuando algo
  relevante cambia (p.ej. su dependencia terminó), Lanchu envía
  `notifications/resources/updated` y el cliente re-lee. Polling (`board.snapshot`) es el
  respaldo para clientes sin suscripciones.
- **Gobernar:** como toda acción pasa por Lanchu, cada una se **valida contra las
  reglas/alcance** antes de aplicarse y se **registra en el audit log**. No hay canal
  lateral entre agentes.
- **Coordinar con el exterior:** los **webhooks** conectan el event bus con sistemas
  externos en ambas direcciones.

### Decisiones de diseño fijadas

- **Coordinación mediada, no directa.** Los agentes no intercambian mensajes
  peer-to-peer; todo va por el estado compartido de Lanchu. Esto es lo que hace posible
  la gobernanza.
- **Control de alcance = bloqueo duro.** Si un agente intenta reclamar algo tomado o
  fuera de su rol, la tool **falla con error**; no puede continuar.
- **Protocolo = MCP.** Lanchu es un servicio compartido que cada agente consulta; MCP es
  la capa correcta. A2A (agente↔agente) queda fuera porque sería orquestación/mensajería
  directa. Ver [`DEFINITION.md` §6](./DEFINITION.md#decisión-de-protocolo-mcp-no-a2a).
- **Notificaciones = MCP nativas** (resource subscriptions); polling como respaldo.

---

## 2. Recursos MCP (lo que agentes y supervisor observan)

Recursos de **solo lectura** y **suscribibles**. Representan la verdad compartida.

| URI del recurso | Contenido | Se actualiza cuando… |
|-----------------|-----------|----------------------|
| `lanchu://board` | Tablero: agentes activos, actividad, tareas. | cualquier `agent.*` / `task.*`. |
| `lanchu://tasks/mine` | Tareas del agente. | cambia una tarea suya. |
| `lanchu://tasks/available` | Tareas disponibles para su rol. | se crea/libera/reclama una tarea. |
| `lanchu://task/{id}` | Detalle + dependencias + dueño. | esa tarea cambia. |
| `lanchu://org/rules` | Reglas/políticas (los límites). | el supervisor actualiza reglas. |
| `lanchu://docs/{id}` | Un documento compartido. | ese doc se actualiza. |
| `lanchu://me` | Identidad, rol y alcance del agente. | cambia su rol/alcance. |
| `lanchu://audit` | Registro inmutable de actividad. | ocurre cualquier evento. |

**Flujo de coordinación mediada:** el agente A se suscribe a `lanchu://tasks/mine`.
El agente B termina su tarea → Lanchu emite `task.completed`, desbloquea la tarea de A y
envía `resources/updated` para `lanchu://tasks/mine`. A re-lee y actúa. **A y B nunca se
hablaron**: se coordinaron a través de Lanchu.

---

## 3. Tools de los agentes

### `session.*` — identidad y presencia
| Tool | Entradas clave | Devuelve | Notas |
|------|----------------|----------|-------|
| `session.register` | `org`, `project`, `role` | identidad, alcance, contexto mínimo | Emite `agent.registered`. |
| `session.whoami` | — | identidad + rol + alcance | El agente recuerda quién es y qué puede tocar. |
| `session.heartbeat` | `branch?`, `activity` | ok | Alimenta el panel. Emite `agent.heartbeat`. |
| `session.leave` | — | ok | Libera tareas reclamadas. Emite `agent.left`. |

### `task.*` — coordinación mediada + límites
| Tool | Entradas clave | Devuelve | Notas |
|------|----------------|----------|-------|
| `task.list` | `filter` (`mine`/`available`/`status`) | lista | Vista *pull*. |
| `task.get` | `id` | detalle + dependencias + dueño | — |
| `task.check_scope` | `id` | `yours` / `someone_else` / `out_of_role` | Consulta antes de actuar. |
| `task.claim` | `id`, `branch?` | tarea reclamada **o ERROR** | **Bloqueo duro** + lock atómico. Evita duplicar. Emite `task.claimed`. |
| `task.update` | `id`, `status`, `note?`, `branch?` | tarea actualizada | `done` **desbloquea dependientes**. Emite `task.started/blocked/completed`. |
| `task.release` | `id` | ok | Otro agente puede tomarla. Emite `task.released`. |
| `task.create` | `title`, `role?`, `deps?` | tarea creada | Según permisos del rol. |
| `task.handoff` | `id`, `note` | ok | Handoff explícito **enrutado por Lanchu** (logueado, no peer-to-peer). Emite `task.handoff`. |

> Nota: **no** hay una tool de "decidir el plan" (tipo decomposición automática o
> `task.next` como cerebro). Lanchu es desopinado sobre el plan; el plan lo pone un
> humano, los agentes o un orquestador externo. Lanchu solo coordina y acota.

### `doc.*` — documentación viva
| Tool | Entradas clave | Devuelve | Notas |
|------|----------------|----------|-------|
| `doc.list` / `doc.search` | `query?` | docs | — |
| `doc.read` | `id` | contenido | Las tools empujan a leer antes de actuar. |
| `doc.update` / `doc.create` | `id?`, `content` | doc | Controlado por rol. Emite `doc.updated`. |

### `org.*` — reglas y contexto
| Tool | Devuelve | Notas |
|------|----------|-------|
| `org.rules` | reglas/políticas a cumplir (los límites) | — |
| `org.context` | contexto mínimo para rol/tarea | Optimiza tokens. |

### `board.*` — respaldo *pull*
| Tool | Devuelve | Notas |
|------|----------|-------|
| `board.snapshot` | estado completo del tablero | Fallback para clientes sin suscripciones. |

---

## 4. Gobernanza (cómo se aplican los límites)

Cada tool que **muta** estado pasa por dos pasos antes de aplicarse:

1. **Chequeo de alcance/reglas.** Se evalúa la acción contra el `role` del agente y las
   `rules` de la org. Si viola el alcance → **error** (bloqueo duro) + evento
   `scope.violation`.
2. **Registro en audit log.** Toda acción aplicada (y todo intento bloqueado) queda en
   `lanchu://audit`, con actor, acción, sujeto, rama y coste/tokens si están disponibles.

**Qué define un rol (el alcance):**
- Qué tareas puede reclamar (por proyecto, etiqueta, tipo).
- Qué recursos/docs puede leer y escribir.
- Qué tools puede usar.
- (Roadmap) Presupuesto de tokens/coste y cuotas.

El supervisor ve todo esto en el panel y en `lanchu://audit`. **Confiar = poder ver +
poder acotar.**

---

## 5. Eventos

Vocabulario común que produce el event bus:

```
agent.registered   agent.heartbeat    agent.left
task.created       task.claimed       task.released     task.started
task.completed     task.blocked       task.handoff
doc.created        doc.updated
scope.violation    branch.changed
```

**Forma de un evento:**
```json
{
  "type": "task.completed",
  "org": "acme",
  "project": "landing",
  "actor": { "agent": "agent-7", "role": "frontend" },
  "subject": { "kind": "task", "id": "task-42" },
  "data": { "branch": "feat/hero", "note": "Hero listo", "tokens": 18240 },
  "timestamp": "2026-07-09T14:30:00Z"
}
```

Los eventos alimentan: (1) el panel, (2) las notificaciones MCP `resources/updated`, y
(3) los webhooks salientes. También son la materia prima del audit log.

---

## 6. Webhooks

### 6.1 Salientes (Lanchu → exterior)
Registras una URL y Lanchu hace `POST` cuando ocurren eventos que te interesan.

**Config:**
```json
{
  "url": "https://hooks.example.com/lanchu",
  "events": ["task.completed", "scope.violation"],
  "org": "acme",
  "project": "landing",
  "secret": "whsec_..."
}
```
- `events`: filtro (o `*` para todos).
- `secret`: el body se firma con **HMAC-SHA256** en `X-Lanchu-Signature` para verificar
  autenticidad.
- Entrega **at-least-once** con reintentos y backoff.

**Casos de uso:** avisar a Slack/Discord al completar una tarea; **alertar al supervisor
ante un `scope.violation`**; disparar CI/CD; volcar el audit a un dashboard externo.

### 6.2 Entrantes (exterior → Lanchu)
Una URL de Lanchu que otros sistemas llaman para disparar acciones.

- `POST /hooks/github` — un `push` crea/avanza una tarea.
- `POST /hooks/schedule` — un scheduler dispara una **función recurrente** (roadmap).
- `POST /hooks/intake` — un formulario o email entrante crea una tarea.

Los webhooks entrantes se autentican por firma/token y **respetan las reglas de la org**
(pasan por el mismo chequeo de gobernanza).

---

## 7. Cómo se resuelve cada desafío (mapa a la definición)

| Desafío (DEFINITION.md §4) | Mecanismo aquí |
|----------------------------|----------------|
| Identidad y registro | `session.register` + recurso `lanchu://me` |
| Límites de alcance | Chequeo de gobernanza + bloqueo duro en `task.claim` + `task.check_scope` |
| Coordinación mediada | Estado compartido + `task.*` con lock atómico + eventos |
| Estado compartido en vivo | Recursos MCP + `resources/updated` + panel |
| Documentación viva | `doc.*` + evento `doc.updated` |
| Confianza y trazabilidad | Event bus → `lanchu://audit` → panel |
| Foco y eficiencia | `org.context` (contexto mínimo por rol/tarea) |
| Recurrencia | Webhook entrante `POST /hooks/schedule` (roadmap) |
| Simplicidad | Un proceso local; `npx lanchu` levanta todo |
