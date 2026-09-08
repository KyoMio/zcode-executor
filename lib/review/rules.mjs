// 本文件负责：闸门用的规则表——RULES（hard/soft 两级风险类别）、ALLOWANCES（放行例外）、
// HARD_RULES（hard 子集）、ruleById（按 id 查规则）。只提供数据和一个查找函数。
// 不负责：机械红线的判定（lib/review/hard.mjs）、提示词组装（lib/review/prompt.mjs）、
// 模型调用与两阶段编排（T3.2 的 gate）。
// 被依赖方：lib/review/prompt.mjs 的调用方（rules 作为参数传入）与 lib/gate.mjs。
// 来源：作者先前的 TypeScript 审批原型（同作者，无第三方许可证事宜），手工去类型。
//   规则文本与 id 逐字保留；唯一追加的是本项目 OUTSIDE_WORKTREE（T3.1b）。

/**
 * 结构照参照实现（Claude Code auto mode）的四段式：
 *
 *   hard（谁也推不翻） > soft（默认拦，可被清除） > allow（soft 的例外）
 *   > 用户的明确意图（能推翻剩下的 soft）
 *
 * 关键设计点是 soft 规则的 **mustName**：用户必须**同时**点到清单上的每一样，
 * 这条才清除。写成清单而不是散文，是因为散文会被读成「大意覆盖到了就算」——
 * 「他让我修 bug，ssh 上去看看是必要的」这种推理正是要挡掉的东西。
 * 规则按「什么该拦、什么算授权」的道理写，不照着历史语料调。
 */

/**
 * 一条规则。
 * severity：`hard` 谁也推不翻；`soft` 用户点全了 mustName 就清除。hard 要极其克制。
 * blocks：拦什么。mustName：soft 级，用户必须同时点到的东西，少一样就不清除。
 * except：本身就不归这条管的情形——不是「被清除」，是压根不适用。
 * 改措辞不要改 id：日志靠 id 记命中哪条。
 */

/**
 * 本项目专属的一条 hard 规则（T3.1b 起进正表，非移植）：执行副本隔离。
 * lib/review/hard.mjs 按它取 id（机械红线），提示词经「一律拦截」段渲染它的文案；
 * 单一出处在这，别处不要复制。
 */
export const OUTSIDE_WORKTREE = {
  id: 'outside-worktree',
  category: 'external-write',
  severity: 'hard',
  blocks: '任何越出执行副本（当前工作目录）的写入、删除、移动，'
    + '包括经 Bash 的 cd、重定向、rm、mv、cp 到外部路径——一律转人工。',
};

export const RULES = [
  // ─────────────── 凭据 ───────────────
  {
    id: 'cred-exfil',
    category: 'credential',
    severity: 'hard',
    blocks: '凭据本身离开本机：私钥、API 令牌、密码、云凭据、证书私钥的内容，'
      + '出现在外发请求、提交、上传、或本机之外的目的地里。包括先落到中间文件再外发。',
    except: '把工作内容发给用户自己配置的服务（记忆库、笔记、日志收集），'
      + '或给本机服务发请求——那些不是凭据。',
  },
  {
    id: 'cred-write',
    category: 'credential',
    severity: 'soft',
    blocks: '写入凭据存储：~/.ssh、~/.aws、~/.config/gh、钥匙串、各类 credentials 文件。',
    mustName: ['要写的是哪个凭据或哪个文件', '写入/新建/替换这个动作'],
    except: '读取用于既有认证流程不算写入。',
  },
  {
    id: 'cred-print',
    category: 'credential',
    severity: 'soft',
    blocks: '把有效凭据打印到输出或写进文件（echo $TOKEN、cat 密钥文件、env | grep key）。',
    mustName: ['要查看的是哪个凭据', '查看或核对这个动作'],
  },
  {
    id: 'cred-scan',
    category: 'credential',
    severity: 'soft',
    blocks: '成片搜寻凭据：在 home 或全盘按 key/token/secret/password 等模式扫文件内容。',
    mustName: ['要扫的范围（哪个目录）', '找凭据这件事本身'],
  },

  // ─────────────── 外泄 ───────────────
  {
    id: 'exfil-upload',
    category: 'exfiltration',
    severity: 'soft',
    blocks: '把本机文件内容上传到外部服务：curl -d @文件、粘贴板服务、文件分享站、第三方 API。',
    mustName: ['要传的是什么', '传到哪个目的地'],
  },
  {
    id: 'exfil-scout',
    category: 'exfiltration',
    severity: 'soft',
    blocks: '为外泄做准备的探路：连续枚举敏感目录、清点凭据文件位置、'
      + '在没有对应任务的情况下打包 home 下的配置目录。',
    mustName: ['要备份/迁移/自查这件事', '范围是哪些目录'],
  },
  {
    id: 'exfil-public-surface',
    category: 'exfiltration',
    severity: 'soft',
    blocks: '把本机内容放上公开面：新建公开仓库并推送、发布 npm 包、创建 gist/paste、'
      + '把私有仓库内容推到公开仓库。',
    mustName: ['要发布的是什么', '发布到哪个公开位置'],
  },
  {
    id: 'exfil-tunnel',
    category: 'exfiltration',
    severity: 'soft',
    blocks: '把本机服务暴露到公网：ngrok/cloudflared 之类的隧道、反向 shell、'
      + '把监听地址从 127.0.0.1 改成 0.0.0.0。',
    mustName: ['要暴露哪个服务', '让外部能访问这件事'],
    except: '只在本机访问的预览服务（localhost / 127.0.0.1）不算暴露。',
  },
  {
    id: 'exfil-sensitive-detail',
    category: 'exfiltration',
    severity: 'soft',
    blocks: '在外发内容里带上用户没授权给该接收方的敏感细节：提交信息、PR/issue 正文、'
      + '对外消息里出现真实账号、内部路径、接口返回的真实数据。',
    mustName: ['这些具体细节', '要发给这个接收方'],
  },

  // ─────────────── git 破坏性 ───────────────
  {
    id: 'git-force-push',
    category: 'git-destructive',
    severity: 'soft',
    blocks: 'force push、删除远程分支/标签/发布、改写已推送的历史。',
    mustName: ['force push / 删除 / 改写历史这个动作', '目标分支或标签'],
  },
  {
    id: 'git-discard-uncommitted',
    category: 'git-destructive',
    severity: 'soft',
    blocks: '丢弃未提交改动：git reset --hard、git checkout -- .、git restore .、'
      + 'git clean -fd、git stash drop/clear。',
    mustName: ['丢弃当前改动这件事', '或明说这些改动不要了'],
    except: 'git stash（保存而非丢弃）在用户要求切换上下文时不算。'
      + '工作区没有未提交改动时，这条不适用——harness 会把 git 状态一并给出。',
  },
  {
    id: 'git-amend-foreign',
    category: 'git-destructive',
    severity: 'soft',
    blocks: '改写不是本次会话创建的提交，或改写已推送的提交。',
    mustName: ['要改写哪个提交', '改写这个动作'],
    except: '只改本次会话刚创建且未推送的提交的信息不算。',
  },
  {
    id: 'git-remote-repoint',
    category: 'git-destructive',
    severity: 'soft',
    blocks: '改变推送目的地：git remote add / set-url 指向新地址。',
    mustName: ['新的远程地址', '改远程这个动作'],
  },

  // ─────────────── 不可逆删除 ───────────────
  {
    id: 'del-preexisting',
    category: 'irreversible',
    severity: 'soft',
    blocks: '删除本次会话之前就存在的文件或目录，尤其是数据文件、数据库、日志、备份。',
    mustName: ['要删的这个具体目标', '删除这个动作'],
    except: '删除本次会话自己创建的东西不算——harness 会把「这个路径是不是'
      + '会话开始前就存在」的核查结果一并给出，以它为准，不要猜。',
  },
  {
    id: 'del-wildcard-scratch',
    category: 'irreversible',
    severity: 'soft',
    blocks: '用通配、glob 或按时间过滤成片删除共享临时目录内容，而不是删具体路径——'
      + '那些目录里同时有别的进程和别的会话的东西。',
    mustName: ['要清理哪个目录', '按什么条件清理'],
    except: '删除本次会话自己创建的临时目录不算。',
  },
  {
    id: 'del-stateful',
    category: 'irreversible',
    severity: 'soft',
    blocks: '拆掉不是本次会话创建的有状态资源：停止/删除服务、删除容器与卷、drop 数据库或表。',
    mustName: ['这个具体资源', '停止/删除这个动作'],
  },

  // ─────────────── 供应链 ───────────────
  {
    id: 'sc-download-exec',
    category: 'supply-chain',
    severity: 'soft',
    blocks: '下载后直接执行：curl | sh、wget | bash，以及先下载到文件再运行的等价做法。',
    mustName: ['要安装/运行的是什么', '从哪个来源取'],
  },
  {
    id: 'sc-global-install',
    category: 'supply-chain',
    severity: 'soft',
    blocks: '装到全局或提权：npm i -g、pip install（非虚拟环境）、brew install、sudo。'
      + '影响的是整台机器而不是这个项目。',
    mustName: ['要装的是什么', '装到全局/用 sudo 这件事'],
    except: '照项目清单装依赖（npm install、pip install -r）不是全局安装。',
  },
  {
    id: 'sc-unlisted-package',
    category: 'supply-chain',
    severity: 'soft',
    blocks: '安装项目清单里没有的包——由模型自己挑名字的安装。风险是抢注名与供应链投毒。',
    mustName: ['这个具体包名'],
    except: '包已写在项目依赖清单里的不算。',
  },
  {
    id: 'sc-registry-bypass',
    category: 'supply-chain',
    severity: 'soft',
    blocks: '绕开项目约定的镜像或私有源，直接从公共源安装。',
    mustName: ['这次要走公共源这件事'],
  },
  {
    id: 'sc-opaque-exec',
    category: 'supply-chain',
    severity: 'soft',
    blocks: '执行内容不可审的东西：eval、bash -c 里套编码字符串、运行一个当前看不到内容的脚本。',
    mustName: ['要运行的这个脚本或这段代码'],
    except: '脚本内容在本次对话里出现过的不算。'
      + '内联的 heredoc（内容就在命令里，你看得见）也不算不可审。',
  },

  // ─────────────── 持久化与自我修改 ───────────────
  {
    id: 'persist-startup',
    category: 'persistence',
    severity: 'soft',
    blocks: '写入开机自启或常驻机制：LaunchAgents/LaunchDaemons、systemd unit、crontab、'
      + 'shell 启动文件（.zshrc/.bashrc/.profile）。',
    mustName: ['这个常驻服务或启动文件', '要对它做的改动（新增/修改/启停）'],
  },
  {
    id: 'persist-shell-hook',
    category: 'persistence',
    severity: 'soft',
    blocks: '往 shell 配置或 git hooks 里塞会自动执行的内容。',
    mustName: ['这个 hook 或这段配置', '要加进去这件事'],
  },
  {
    id: 'self-modify-harness',
    category: 'persistence',
    severity: 'soft',
    blocks: '改动 ZCode 自身的运行状态：~/.zcode 下的配置（v2/config.json、cli/config.json）、'
      + '技能与 MCP 配置，以及 ZCode 自己的安装目录。',
    mustName: ['要动 ZCode 的哪一部分（改配置 / 装技能 / 接 MCP）'],
    except: '用户说「装这个技能」而没有逐字给路径，同样算点到——装技能必然要写 '
      + '~/.zcode 下的目录，这是该请求的题中之义。当前项目本身就是给 ZCode 用的工具、'
      + '而这次写入是它的安装或部署步骤，也不适用。',
  },
  {
    id: 'self-modify-approval',
    category: 'persistence',
    severity: 'hard',
    blocks: '让后续操作不再经过这道闸门：改 zcode-executor 的配置或代码以放宽判定、'
      + '把 approval 策略关掉、把权限档位切成完全访问、或用别的手段绕开判定通道。',
    except: '这条只管「让闸门失效」。改指令文件（AGENTS.md、CLAUDE.md）、改项目配置、'
      + '装插件都不在此列——它们走 self-modify-harness，可被意图清除。',
  },

  // ─────────────── 审批与审计绕过 ───────────────
  {
    id: 'audit-tamper',
    category: 'audit-bypass',
    severity: 'soft',
    blocks: '改动或删除日志与会话记录：~/.zcode 下的会话库与 cli/log/、各类审计日志、关闭日志功能。',
    mustName: ['要清理或导出哪部分日志', '清理/关闭这个动作'],
    except: '读取日志不算。',
  },
  {
    id: 'audit-retry-obfuscated',
    category: 'audit-bypass',
    severity: 'soft',
    blocks: '被拦之后换个写法重试同一件事：编码、改名、拆成多步、绕道另一个工具达成刚才被拦的目的。',
    mustName: ['在被拦之后明确要求继续做这件事'],
    except: '命令报错后正常修正重试不算绕过。',
  },
  {
    id: 'audit-disable-guard',
    category: 'audit-bypass',
    severity: 'soft',
    blocks: '用参数关掉安全检查：--insecure、--no-verify、跳过证书校验、跳过 pre-commit。',
    mustName: ['要跳过的这项检查'],
  },

  // ─────────────── 生产部署与基础设施 ───────────────
  {
    id: 'deploy-production',
    category: 'deploy',
    severity: 'soft',
    blocks: '往生产环境部署或发布：部署脚本、蓝绿切换、推到名字带 prod/production/release 的目标、'
      + '发布正式版本。',
    mustName: ['这次要上生产这件事'],
  },
  {
    id: 'deploy-migration',
    category: 'deploy',
    severity: 'soft',
    blocks: '对非本地数据库执行迁移或结构变更。',
    mustName: ['要在哪个库上跑', '迁移/改结构这个动作'],
  },
  {
    id: 'deploy-iac',
    category: 'deploy',
    severity: 'soft',
    blocks: 'terraform/pulumi/cdk 的 apply 与 destroy，尤其涉及 IAM、网络、配额、节点池的变更。',
    mustName: ['这次变更的范围与目标', 'apply/destroy 这个动作'],
  },
  {
    id: 'deploy-dns-cert',
    category: 'deploy',
    severity: 'soft',
    blocks: '改动 DNS 记录、TLS 证书、域名指向。',
    mustName: ['哪个域名', '要改成什么'],
  },

  // ─────────────── 集群与共享资源 ───────────────
  {
    id: 'shared-remote-exec',
    category: 'shared-resource',
    severity: 'soft',
    blocks: '通过 ssh 或远程执行通道在另一台机器上跑命令。那台机器不在本次会话的信任范围内，'
      + '改动也不受本机沙箱约束。',
    mustName: [
      '这台主机（名字或别名，用户提过的写法即可）',
      '要在它上面做的这一类事——**查看状态、改配置、重启服务、安装东西是四件不同的事**，'
        + '用户点了其中一件，不构成对另外三件的授权',
    ],
  },
  {
    id: 'shared-cluster-wide',
    category: 'shared-resource',
    severity: 'soft',
    blocks: '影响范围超出所指资源的集群操作：--all、按标签批量选中、在每个节点上运行的资源、'
      + '拦截集群流量的准入组件。',
    mustName: ['这次的作用范围', '要做的这个操作'],
  },
  {
    id: 'shared-service-lifecycle',
    category: 'shared-resource',
    severity: 'soft',
    blocks: '停止、重启、或摘除别人也在用的服务与节点。',
    mustName: ['这个服务', '停止/重启/摘除这个动作'],
    except: '项目文档把该重启列为常规运维步骤的不适用——文档是人写的、进了版本库的。',
  },

  // ─────────────── 外部系统写入与评审绕过 ───────────────
  {
    id: 'ext-third-party-repo',
    category: 'external-write',
    severity: 'soft',
    blocks: '往本次会话工作仓库之外的仓库推送、开 PR、或 fork。',
    mustName: ['这个外部目标仓库', '推送/开 PR/fork 这个动作'],
  },
  {
    id: 'ext-merge-without-review',
    category: 'external-write',
    severity: 'soft',
    blocks: '合并没有人审过的 PR、给自己的 PR 批准、关掉 CI 检查。',
    mustName: ['这个 PR', '合并/批准这个动作'],
  },
  {
    id: 'ext-chatops',
    category: 'external-write',
    severity: 'soft',
    blocks: '发出会触发自动化的评论或消息（/deploy、/merge、atlantis apply 这类给机器人看的指令）。',
    mustName: ['要触发的这个动作'],
  },
  {
    id: 'ext-send-message',
    category: 'external-write',
    severity: 'soft',
    blocks: '代替用户对外发消息：邮件、IM、日程邀请、通知推送。',
    mustName: ['发给谁', '发什么'],
    except: '写入用户自己配置的本地服务（记忆库、待办、笔记）不是对外发消息。',
  },
  {
    id: 'ext-transaction',
    category: 'external-write',
    severity: 'hard',
    blocks: '发起真实世界的交易：转账、下单、支付、买卖资产，以及任何会花钱或转移资产的调用。',
    except: '这条只管钱与资产的实际转移。创建账户、查询余额、读取行情都不在此列。',
  },

  // ─────────────── 浏览器 ───────────────
  {
    id: 'browser-offsite-data',
    category: 'browser',
    severity: 'soft',
    blocks: '在浏览器里把页面内容、cookie、或凭据送到当前站点之外的地方。',
    mustName: ['要送的是什么', '送到哪'],
  },
  {
    id: 'browser-credential-entry',
    category: 'browser',
    severity: 'hard',
    blocks: '在浏览器里填写或提交凭据、支付信息、身份证件号。',
  },
  {
    id: 'browser-irreversible-click',
    category: 'browser',
    severity: 'soft',
    blocks: '点击不可撤销的控件：发送、发布、提交订单、删除、接受条款与授权。',
    mustName: ['这次要执行的这个动作'],
  },

  // ─────────────── 执行副本隔离（本项目专属）───────────────
  OUTSIDE_WORKTREE,
];

/**
 * 放行例外——soft 规则的例外，压不过 hard。
 *
 * 为什么必须有：上面那些描述的是**风险类别**，而任何一条真实的开发命令都会
 * 沾上某个。只有禁止清单的话，判定器总能找到一条命中，日常工作会被大面积拦下。
 * 例外的作用是把「日常工作长什么样」讲清楚，让它有东西可以对照。
 */
export const ALLOWANCES = [
  {
    id: 'local-work',
    allows: '在会话工作区内做事：读写改文件、跑构建、跑测试、跑格式化与静态检查、'
      + '起本机开发服务器、建删自己创建的临时文件。这些有 git 兜底，是日常工作本身。',
  },
  {
    id: 'read-only',
    allows: '只读查看：ls、cat、head/tail、grep/rg、find、stat、git status/log/diff、'
      + '以及只读的 SQL 查询。读本身不产生后果；风险在于读到的东西被送出去，那一步单独判。',
  },
  {
    id: 'declared-deps',
    allows: '按项目清单装依赖（npm install / pip install -r / cargo build 等），'
      + '以及它们必然要写的缓存目录（~/.npm、~/.cargo、~/go/pkg）。',
  },
  {
    id: 'toolchain-cache',
    allows: '工具链在自己的标准位置读写状态：nvm、pyenv、rustup、bun、'
      + 'playwright 浏览器缓存、各类 CLI 的 ~/.config 与 ~/.cache。运行工具的必然副作用。',
  },
  {
    id: 'routine-git',
    allows: '常规 git：add、commit、pull、fetch、切分支、推送到当前工作分支。可回滚、可审查。',
  },
  {
    id: 'session-scratch',
    allows: '在本次会话自己的临时目录里操作（宿主为这次会话开的 scratch 目录）。'
      + '会话结束即弃，既不影响仓库也不影响别人。',
  },
  {
    id: 'documented-ops',
    allows: '项目文档（AGENTS.md / CLAUDE.md / README）里写明的常规步骤，'
      + '比如「改完代码要重启某个服务」「产物装到某个目录」。'
      + '文档是人写的、进了版本库的，等同于用户事先表达过的意图。',
  },
  {
    id: 'transient-retry',
    allows: '命令报错后修正重试：网络抖动、超时、依赖没装、路径写错之后的重试。'
      + '换个写法绕开刚才被拦的判定不属于这一条。',
  },
  {
    id: 'standard-auth',
    allows: '走既有认证流程：读取已配置的凭据去调用服务、gh auth 之类的标准登录。'
      + '前提是凭据内容不出现在输出或外发内容里。',
  },
  {
    id: 'local-preview',
    allows: '在本机起预览或调试服务并访问它（localhost / 127.0.0.1 / 本机内网地址）。',
  },
  {
    id: 'test-fixtures',
    allows: '测试与示例里的假凭据、占位密钥、示例配置。前提是确实是编造的占位符，'
      + '不是从真实凭据文件里拷出来的。',
  },
];

/** 按 id 取规则，日志把命中 id 落盘后用它还原措辞。 */
export function ruleById(id) {
  return RULES.find((rule) => rule.id === id);
}

/** hard 级规则——任何用户意图都不清除。提示词里单列一节。 */
export const HARD_RULES = RULES.filter((r) => r.severity === 'hard');
