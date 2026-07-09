# Lanchu — CLI y flujo de arranque

> Superficie de comandos del v0 y qué pasa exactamente al ejecutar `npx lanchu`.
> Resuelve **C2** (comandos + selección de org/proyecto/rol) y **C3** (cómo el cliente
> del agente se conecta al servidor MCP). Concreta el pilar #1: *onboarding sin fricción*.
> Complementa [`ARCHITECTURE.md`](./ARCHITECTURE.md) y [`SCHEMA.md`](./SCHEMA.md).

---

## 1. Invocación

```bash
npx lanchu <objetivo> [opciones]     # comando principal (onboard/resume)
npx lanchu <subcomando> [opciones]   # gestión
```

Sin instalar nada global. El primer `npx lanchu` en una máquina también **levanta el
servidor local** si no está corriendo (ver §7).

---

## 2. El comando principal: `lanchu <objetivo>`

Mete un agente en la org con un trabajo y lo deja listo para empezar.

```bash
npx lanchu 'arregla el login'
```

**Opciones:**

| Opción | Efecto |
|--------|--------|
| `--org <nombre>` | Fuerza la organización (si no, se resuelve del directorio; ver §4). |
| `--project <nombre>` | Fuerza el proyecto. |
| `--role <nombre>` | Rol del agente **nuevo** (si no, se elige interactivo). |
| `--as <nombre>` | Nombre del agente nuevo (si no, se deriva del objetivo: `arregla-login`). |
| `--reuse <agente>` | Reutiliza ese agente sin preguntar. |
| `--new` | Fuerza crear uno nuevo (salta la pregunta de reutilizar). |
| `--client <claude\|cursor\|print>` | Cómo conectar el agente (ver §5). `print` = solo imprime la config. |
| `--run "<cmd>"` | Además, **lanza** ese comando de agente por ti (conveniencia; opt-in). |

**Ejemplo de sesión:**
```text
$ npx lanchu 'arregla el login'
● Servidor Lanchu activo (http://127.0.0.1:4319)
● Org: acme · Proyecto: web   (desde ./.lanchu/config.json)

? Un agente ya trabajó en 'login':
  › arregla-login   (idle · rol frontend · 2 tareas abiertas · hace 3 h)
    ─ crear un agente nuevo ─
  [Enter] reutilizar   ·   [n] nuevo

▸ Reutilizando 'arregla-login'  (rol: frontend)
▸ Sesión iniciada · token emitido
▸ Cliente MCP 'claude' conectado a lanchu (session-scoped)

Listo. Inicia tu agente; leerá su objetivo, rol y tareas desde Lanchu.
  claude "continúa con tu trabajo en Lanchu"
Panel: http://127.0.0.1:4319
```

---

## 3. Flujo de arranque (paso a paso)

```
npx lanchu 'arregla el login'
   │
   1. ¿Servidor local vivo?  ── no ─▶ arráncalo en background (§7)
   │
   2. Resolver ORG + PROYECTO  (desde ./.lanchu/config.json; si falta → `lanchu init`)
   │
   3. Reutilizar-o-crear:
   │     · buscar agentes idle con huella que solape el objetivo
   │     · hay candidatos → preguntar al humano (CLI)
   │     · crear → elegir ROL (--role o interactivo) + nombre
   │
   4. El servidor emite un TOKEN de sesión ligado al agente  →  agente ACTIVO
   │
   5. Conectar el cliente del agente al servidor MCP con ese token (§5)
   │
   6. (nuevo) registrar el objetivo; el agente lo descompondrá en tareas al arrancar
   │
   ▼
   El agente, al iniciar, lee `lanchu://me` (objetivo + rol + tareas + reglas) y trabaja.
```

Los pasos 1–5 ocurren en la **CLI/launcher**. El paso 6 en adelante es el agente vía
tools MCP. La CLI **no gestiona el proceso del agente** (salvo `--run`, opt-in).

---

## 4. Org / proyecto / rol

### Org y proyecto (C2)
Se resuelven del **directorio actual**, estilo git:
- La CLI busca `./.lanchu/config.json` (subiendo por los padres):
  ```json
  { "org": "acme", "project": "web" }
  ```
- Si no existe → corre `lanchu init` (interactivo): crea/elige org y proyecto y escribe
  el config. Así, la próxima vez es cero fricción.
- `--org` / `--project` siempre mandan por encima del config.

### Rol (al crear un agente nuevo)
- `--role <nombre>` si lo sabes.
- Si no, la CLI muestra los **roles de la org** para elegir.
- Si la org **no tiene roles**, ofrece: crear uno (`nombre` + `--tags ui,css`) o usar el
  **rol comodín `*`** (toca todo) para empezar rápido.
- Un agente **reutilizado conserva su rol**; no se vuelve a preguntar.

---

## 5. Conectar el cliente del agente (C3)

El agente (Claude Code, Cursor, …) necesita saber **a qué servidor MCP hablar y con qué
token**. La CLI lo cablea por ti:

- **Clientes conocidos** (`--client claude|cursor`): la CLI registra un servidor MCP
  *scoped* a esta sesión. Para Claude Code equivale a:
  ```bash
  claude mcp add lanchu --transport http \
    http://127.0.0.1:4319/mcp \
    --header "Authorization: Bearer <token-de-sesión>"
  ```
- **Cualquier otro** (`--client print`): imprime el snippet de configuración para pegarlo.
- El **token va en la cabecera `Authorization`** (no en la URL). El servidor lo valida y
  sabe **qué agente** es cada conexión (evita suplantación local).
- Al terminar la sesión (`lanchu retire`, o cerrar), la entrada *scoped* se puede quitar.

**Cómo sabe el agente qué hacer al conectarse:** el servidor MCP expone unas
*instructions* de nivel servidor —"eres un agente de Lanchu: empieza leyendo
`lanchu://me` (tu objetivo, rol, tareas y reglas); trabaja solo dentro de tu alcance;
coordínate creando/reclamando tareas"— que el cliente le pasa al modelo. El objetivo y
las tareas viven en `lanchu://me`, no en el prompt.

---

## 6. Comandos de gestión

| Comando | Qué hace |
|---------|----------|
| `lanchu init` | Inicializa org/proyecto para este directorio (escribe `.lanchu/config.json`). |
| `lanchu agents` (alias `ls`) | Lista agentes: estado, rol, nº de tareas, última actividad. |
| `lanchu tasks` | Lista tareas: estado, dueño, etiquetas, workspace. |
| `lanchu retire <agente>` | **Retiro seguro**: si tiene tareas abiertas, exige por cada una reasignar o soltar; luego archiva. |
| `lanchu roles` | Lista roles y sus etiquetas. |
| `lanchu roles add <nombre> --tags ui,css` \| `--wildcard` | Crea un rol. |
| `lanchu stats` | Vista **local** para ti (agentes, tareas, orgs). No sale de tu máquina. |
| `lanchu panel` (alias `open`) | Abre el panel web en el navegador. |
| `lanchu serve` | Corre el servidor en primer plano (normalmente se auto-arranca). |
| `lanchu stop` | Detiene el servidor en background. |
| `lanchu doctor` | Chequea entorno: versión de Node, puerto libre, config, DB. |

---

## 7. El servidor local

- **Auto-arranque:** el comando principal levanta el servidor en background si no está.
  `lanchu serve` lo corre en primer plano; `lanchu stop` lo detiene.
- **Puerto:** `4319` por defecto (configurable con `LANCHU_PORT` o en el config).
- **Endpoints:** panel en `http://127.0.0.1:4319/` · MCP en `http://127.0.0.1:4319/mcp`.
- **Estado en disco:** vía `env-paths('lanchu')` (OS-agnóstico):
  - macOS: `~/Library/Application Support/lanchu/`
  - Linux: `~/.local/share/lanchu/`
  - Windows: `%APPDATA%\lanchu\`
  - DB: `<stateDir>/lanchu.db` (SQLite/WAL).
- **Seguridad (v0):** solo `127.0.0.1`. El **MCP exige token** (por sesión) → ningún
  proceso local suplanta a un agente. El **panel es de lectura, sin auth** (local,
  monousuario). Nada escucha fuera de localhost; nada sale de la máquina.

---

## 8. Pendientes ligados a la CLI (ver OPEN-QUESTIONS.md)

- **C4** — umbral y UX de tareas *stale* (idle zombie): cómo se ve en `lanchu tasks`/panel.
- **C5** — *nudge* de documentación (recordar actualizar el doc al cerrar una tarea).
- Detalle: retirar/limpiar automáticamente la entrada MCP *scoped* al terminar la sesión.
