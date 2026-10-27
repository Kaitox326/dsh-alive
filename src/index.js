/**
 * dsh-alive — 活人感。
 *
 * 五条机制，全部落在 DSH 的宿主扩展点上，不改前端、不碰模型：
 *
 * 1. 不回        agent/pre-step 返回 { kind: 'reject' }，这一轮不进模型。
 * 2. 分条 + 延迟 注入节奏指令；可选自带一个停顿工具（默认关，已有 dsh-chat-pace 就别开）。
 * 3. 状态外置    sessionProjections 里的 mood / energy / intimacy，跟着会话落盘。
 * 4. 脏记忆     从用户消息里抽印象条目，不是档案。
 * 5. 差序对待   intimacy 决定注入的措辞，也决定说话有多硬。
 *
 * 状态全部由 session 事件推导（apply(state, event)），不写外部文件、不让模型自评。
 *
 * @module dsh-alive
 */
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'alive'

/** 只用 agents；其余服务在 apply 里局部注入，缺了也不拖垮插件。 */
export const inject = ['agents']

export const Config = z.object({
  enabled: z.boolean().default(true),

  /** 第 1 条：装死的概率。0 = 关闭。只对很短的输入生效。 */
  silentChance: z.number().default(0),
  /** 超过这个字数的输入一律回复，不装死。 */
  silentMaxChars: z.number().default(6),

  /** 第 2 条：注入节奏指令。 */
  paceHint: z.boolean().default(true),
  /** 节奏指令里提到的工具名。装了 dsh-chat-pace 就是 hold_for_followup。 */
  paceToolName: z.string().default('hold_for_followup'),
  /** 自己注册一个停顿工具。没装 chat-pace 时才设 true，否则工具重名会报错。 */
  selfPaceTool: z.boolean().default(false),

  /** 第 3、4、5 条：状态与记忆注入。 */
  stateHint: z.boolean().default(true),
  /** 记忆里最多留几条印象。 */
  maxImpressions: z.number().default(5),
})

const MOOD_LOW = 0.3
const MOOD_HIGH = 0.7
const ENERGY_LOW = 0.3

/** 同情是雷，掉得比挨骂狠。 */
const PITY = ['你还好吗', '还好吗', '没事吧', '注意身体', '别太勉强', '别太累', '多休息', '照顾自己']
const INSULT = ['滚', '傻', '蠢', '烦死', '闭嘴', '有病']
const PRAISE = ['厉害', '好听', '喜欢', '谢谢', '牛']

/** 只抽带情绪的印象，不抽档案。 */
const IMPRESSIONS = [
  /我叫([^\s，。！？]{1,8})/,
  /我(?:很|最|特别)?(?:喜欢|讨厌|受不了)([^\s，。！？]{2,12})/,
  /我在([^\s，。！？]{2,12}?)(?:上班|工作|上学|读书)/,
]

/** 状态结构。zod 校验，跟着 projection 落盘。 */
const StateSchema = zod.object({
  mood: zod.number(),
  energy: zod.number(),
  intimacy: zod.number(),
  lastText: zod.string(),
  impressions: zod.array(zod.string()),
  turns: zod.number(),
})

function clamp01(v) {
  return Math.min(1, Math.max(0, v))
}

/** 取消息里的纯文本。 */
function textOf(message) {
  const content = message?.content
  if (!Array.isArray(content)) return ''
  return content
    .filter((b) => b?.type === 'text')
    .map((b) => b.text ?? '')
    .join('')
}

/** 事件 → 状态。纯函数，投影和测试共用。 */
function reduce(state, event) {
  if (event?.type === 'user/message') {
    const source = event.data?.source
    // 自己注入的消息不算数，否则状态会被自己推动
    if (source?.kind === 'plugin') return state

    const text = textOf(event.data)
    let mood = state.mood
    if (PITY.some((w) => text.includes(w))) mood -= 0.25
    else if (INSULT.some((w) => text.includes(w))) mood -= 0.15
    else if (PRAISE.some((w) => text.includes(w))) mood += 0.05

    const fresh = []
    for (const rule of IMPRESSIONS) {
      const hit = text.match(rule)
      if (hit?.[1]) fresh.push(hit[1].trim())
    }
    const impressions = [...state.impressions]
    for (const item of fresh) {
      if (item && !impressions.includes(item)) impressions.push(item)
    }

    return {
      ...state,
      mood: clamp01(mood + 0.02),
      intimacy: clamp01(state.intimacy + 0.01),
      lastText: text,
      impressions: impressions.slice(-8),
      turns: state.turns + 1,
    }
  }

  if (event?.type === 'assistant/message') {
    return { ...state, energy: clamp01(state.energy - 0.03) }
  }

  return state
}

function renderState(state, cfg) {
  const mood =
    state.mood < MOOD_LOW ? '情绪很差，容易变尖' : state.mood > MOOD_HIGH ? '心情不错，话会多一点' : '心情一般'
  const energy = state.energy < ENERGY_LOW ? '很累了，懒得多说' : '还有精力'
  const close =
    state.intimacy < 0.3
      ? '你和这个人还很生'
      : state.intimacy < 0.6
        ? '你和这个人眼熟，但不算熟'
        : state.intimacy < 0.85
          ? '你和他算熟了'
          : '你和他很熟，说话可以不客气'

  const lines = [`（此刻：${mood}；${energy}；${close}。）`]
  const kept = state.impressions.slice(-cfg.maxImpressions)
  if (kept.length) {
    lines.push(`你还记得这些：${kept.join('、')}。用得上就自然带出来，别罗列，别说"我记得"。`)
  }
  return lines.join('\n')
}

function renderPace(cfg) {
  return [
    '（说话节奏：一次别说太多，一到两句就够。',
    `要说的话超过两句时，在第一段之后调用 ${cfg.paceToolName} 停 0.4 到 0.8 秒，让文字一块一块出来。`,
    '对方明显话没说完时，也用它等 2 到 3 秒，别对半句话抢答。）',
  ].join('')
}

/** 这一轮要不要装死。 */
function shouldStaySilent(state, cfg) {
  if (!(cfg.silentChance > 0)) return false
  const text = (state.lastText ?? '').trim()
  if (!text || text.length > cfg.silentMaxChars) return false
  // 对方在难受的时候不装死，这不是活人感，是没良心
  if (PITY.some((w) => text.includes(w))) return false
  return Math.random() < cfg.silentChance
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    let timer
    const finish = () => {
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', finish)
      resolve()
    }
    timer = setTimeout(finish, ms)
    if (signal) {
      if (signal.aborted) return finish()
      signal.addEventListener('abort', finish, { once: true })
    }
  })
}

export function apply(ctx, config) {
  const cfg = { ...config }
  if (cfg.enabled === false) return

  ctx.inject(['sessionProjections'], (pctx) => {
    pctx.sessionProjections.register({
      key: 'alive',
      stateVersion: 1,
      stateSchema: StateSchema,
      init: () => ({ mood: 0.5, energy: 0.8, intimacy: 0.2, lastText: '', impressions: [], turns: 0 }),
      apply: (state, event) => reduce(state, event),
    })

    pctx.on(
      'agent/pre-step',
      async ({ agent, signal }, next) => {
        const decision = await next()
        if (decision?.kind !== 'enter' || signal?.aborted) return decision

        const state = pctx.sessionProjections.stateOf(agent.session, 'alive')

        // 第 1 条：这一轮不进模型。消息留在 inbox，下一次唤醒才处理。
        if (!state) return decision
        if (shouldStaySilent(state, cfg)) return { kind: 'reject' }

        const parts = []
        if (cfg.stateHint) parts.push(renderState(state, cfg))
        if (cfg.paceHint) parts.push(renderPace(cfg))
        if (!parts.length) return decision

        const text = parts.join('\n')
        return {
          ...decision,
          messages: [
            ...decision.messages,
            createUserMessage({
              content: [{ type: 'text', text }],
              source: { kind: 'plugin', plugin: name, form: 'snapshot', sections: [{ name, text }] },
            }),
          ],
        }
      },
      { prepend: true },
    )
  })

  if (cfg.selfPaceTool) {
    ctx.inject(['tools'], (tctx) => {
      tctx.tools.register(
        defineTool({
          name: cfg.paceToolName,
          description:
            '停一下再继续。把长回复拆成几块时，在两段之间调用它（0.4~0.8 秒），文字就会一块一块出来，' +
            '像一条条消息。对方话没说完时也用它等 2~3 秒，等对方补完再一起回应，别对半句话抢答。',
          parameters: {
            seconds: { type: 'number', description: '等多久（秒）。拆段 0.4~0.8，等对方补话 2~3。' },
          },
          output: {
            schema: {
              type: 'object',
              properties: { waited: { type: 'number' }, note: { type: 'string' } },
              additionalProperties: true,
            },
            render: (_args, value) => [{ type: 'text', text: value.note }],
          },
          async execute(args, exec) {
            const raw = Number(args?.seconds)
            const seconds = Math.min(8, Math.max(0.2, Number.isFinite(raw) && raw > 0 ? raw : 0.6))
            await sleep(Math.round(seconds * 1000), exec?.signal)
            return { waited: seconds, note: `停了 ${seconds} 秒。继续。` }
          },
          presentCall: (args) => ({
            card: 'generic',
            title: `停 ${Number(args?.seconds) > 0 ? args.seconds : 0.6} 秒`,
            kind: 'other',
          }),
        }),
      )
    })
  }
}

export { reduce as __reduce, renderState as __renderState }
