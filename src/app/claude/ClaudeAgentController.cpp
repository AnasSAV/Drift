#include "app/claude/ClaudeAgentController.h"

#include "app/editor/AppController.h"
#include "app/editor/ProjectFileController.h"
#include "app/mcp/McpController.h"

#include <QCoreApplication>
#include <QDateTime>
#include <QDesktopServices>
#include <QDir>
#include <QFileInfo>
#include <QJsonDocument>
#include <QJsonObject>
#include <QProcess>
#include <QProcessEnvironment>
#include <QSettings>
#include <QStandardPaths>
#include <QTimer>

#ifdef Q_OS_WIN
#include <qt_windows.h>
#endif

namespace {

constexpr auto kAgentDirKey = "claude/agentDir";
constexpr auto kNodePathKey = "claude/nodePath";
// Keeps the activity list cheap to redraw over a long build.
constexpr int kMaxLogRows = 600;

QString str(const QVariantMap &m, const char *key)
{
    return m.value(QLatin1String(key)).toString();
}

bool isAgentDir(const QString &dir)
{
    return !dir.isEmpty() && QFileInfo::exists(QDir(dir).filePath(QStringLiteral("package.json")))
           && QFileInfo::exists(QDir(dir).filePath(QStringLiteral("src/cli.ts")));
}

} // namespace

ClaudeAgentController::ClaudeAgentController(AppController *app, QObject *parent)
    : QObject(parent), m_app(app)
{
    QSettings settings;
    m_agentDir = settings.value(QLatin1String(kAgentDirKey)).toString();
    m_nodePath = settings.value(QLatin1String(kNodePathKey)).toString();

    // Stop a running helper while the event loop and the MCP server it talks to still exist,
    // rather than in the static destructor after the application object is gone.
    connect(QCoreApplication::instance(), &QCoreApplication::aboutToQuit, this, [this]() {
#if QT_CONFIG(process)
        for (QProcess *proc : {m_proc.data(), m_infoProc.data(), m_skillProc.data()}) {
            if (proc && proc->state() != QProcess::NotRunning) {
                proc->disconnect(this);
                proc->kill();
                proc->waitForFinished(2000);
            }
        }
#endif
    });
}

ClaudeAgentController::~ClaudeAgentController()
{
    // The helper would otherwise keep driving an editor that is going away.
    if (m_proc) {
        m_proc->disconnect(this);
        m_proc->kill();
        m_proc->waitForFinished(2000);
    }
    if (m_infoProc) {
        m_infoProc->disconnect(this);
        m_infoProc->kill();
    }
}

// --- setup ---------------------------------------------------------------------------------------

void ClaudeAgentController::setAgentDir(const QString &dir)
{
    const QString clean = dir.trimmed();
    if (clean == m_agentDir)
        return;
    m_agentDir = clean;
    QSettings().setValue(QLatin1String(kAgentDirKey), m_agentDir);
    emit setupChanged();
    refresh();
}

void ClaudeAgentController::setNodePath(const QString &path)
{
    const QString clean = path.trimmed();
    if (clean == m_nodePath)
        return;
    m_nodePath = clean;
    QSettings().setValue(QLatin1String(kNodePathKey), m_nodePath);
    emit setupChanged();
    refresh();
}

// The configured folder, else $DRIFT_AGENT_DIR, else an agent/ folder beside or above the
// executable — which is where it sits in a build tree (build/drift.exe → ../agent).
QString ClaudeAgentController::resolvedAgentDir() const
{
    if (!m_agentDir.isEmpty())
        return m_agentDir;
    const QString env = qEnvironmentVariable("DRIFT_AGENT_DIR");
    if (isAgentDir(env))
        return env;
    QDir dir(QCoreApplication::applicationDirPath());
    for (int up = 0; up < 6; ++up) {
        const QString candidate = dir.filePath(QStringLiteral("agent"));
        if (isAgentDir(candidate))
            return QDir::cleanPath(candidate);
        if (!dir.cdUp())
            break;
    }
    return {};
}

QString ClaudeAgentController::resolveNode() const
{
    if (!m_nodePath.isEmpty())
        return m_nodePath;
    QString node = QStandardPaths::findExecutable(QStringLiteral("node"));
#ifdef Q_OS_WIN
    // GUI apps started from Explorer may not see a PATH change made after login.
    if (node.isEmpty()) {
        const QString programFiles = qEnvironmentVariable("ProgramFiles", QStringLiteral("C:/Program Files"));
        const QString candidate = QDir(programFiles).filePath(QStringLiteral("nodejs/node.exe"));
        if (QFileInfo::exists(candidate))
            node = candidate;
    }
#endif
    return node;
}

ClaudeAgentController::Launch ClaudeAgentController::resolveLaunch() const
{
    Launch launch;
#if !QT_CONFIG(process)
    launch.error = tr("Claude isn't available on this platform.");
    return launch;
#else
    const QString dir = resolvedAgentDir();
    if (dir.isEmpty()) {
        launch.error = tr("Couldn't find the drift-agent folder. Choose the agent folder of your Drift checkout.");
        return launch;
    }
    if (!isAgentDir(dir)) {
        launch.error = tr("%1 isn't a drift-agent folder (no package.json and src/cli.ts).").arg(dir);
        return launch;
    }
    const QDir agent(dir);
    if (!QFileInfo::exists(agent.filePath(QStringLiteral("node_modules/@anthropic-ai/claude-agent-sdk")))) {
        launch.error = tr("drift-agent's packages aren't installed. Run \"npm install\" in %1.").arg(QDir::toNativeSeparators(dir));
        return launch;
    }
    const QString node = resolveNode();
    if (node.isEmpty()) {
        launch.error = tr("Node.js wasn't found. Install it from nodejs.org, or set its path in the panel's setup.");
        return launch;
    }
    launch.program = node;
    launch.workDir = dir;
    // Run the TypeScript sources through tsx when it is installed (a dev checkout: always current),
    // else the compiled dist/.
    if (QFileInfo::exists(agent.filePath(QStringLiteral("node_modules/tsx"))))
        launch.args = {QStringLiteral("--import"), QStringLiteral("tsx"), QStringLiteral("src/cli.ts")};
    else if (QFileInfo::exists(agent.filePath(QStringLiteral("dist/cli.js"))))
        launch.args = {QStringLiteral("dist/cli.js")};
    else
        launch.error = tr("drift-agent isn't built. Run \"npm install\" and \"npm run build\" in %1.").arg(QDir::toNativeSeparators(dir));
    return launch;
#endif
}

void ClaudeAgentController::refresh()
{
#if QT_CONFIG(process)
    if (m_infoProc)
        return;
    const Launch launch = resolveLaunch();
    if (!launch.error.isEmpty()) {
        m_loading = false;
        m_ready = false;
        m_setupError = launch.error;
        emit infoChanged();
        return;
    }
    m_loading = true;
    emit infoChanged();

    auto *proc = new QProcess(this);
    m_infoProc = proc;
    proc->setWorkingDirectory(launch.workDir);
    proc->setProgram(launch.program);
    proc->setArguments(launch.args + QStringList{QStringLiteral("info")});
    connect(proc, &QProcess::finished, this, [this, proc](int exitCode, QProcess::ExitStatus) {
        const QByteArray out = proc->readAllStandardOutput();
        const QByteArray err = proc->readAllStandardError();
        proc->deleteLater();
        m_loading = false;
        // The info line is the last JSON line; anything before it is noise from Node.
        QVariantMap info;
        for (const QByteArray &line : out.split('\n')) {
            const QJsonDocument doc = QJsonDocument::fromJson(line.trimmed());
            if (doc.isObject() && doc.object().value(QStringLiteral("type")).toString() == QLatin1String("info"))
                info = doc.object().toVariantMap();
        }
        if (info.isEmpty()) {
            m_ready = false;
            const QString tail = QString::fromUtf8(err).trimmed().right(400);
            m_setupError = tr("drift-agent didn't start (exit %1). %2").arg(exitCode).arg(tail);
            emit infoChanged();
            return;
        }
        m_skills = info.value(QStringLiteral("skills")).toList();
        m_models = info.value(QStringLiteral("models")).toList();
        m_efforts = info.value(QStringLiteral("efforts")).toStringList();
        const QVariantMap def = info.value(QStringLiteral("default")).toMap();
        m_defaultModel = str(def, "model");
        m_defaultEffort = str(def, "effort");
        const QVariantMap account = info.value(QStringLiteral("account")).toMap();
        m_loggedIn = account.value(QStringLiteral("loggedIn")).toBool();
        m_account = str(account, "method");
        m_userSkillsDir = str(info, "userSkillsDir");
        m_skillProblems = info.value(QStringLiteral("problems")).toList();
        m_setupError = str(info, "error");
        m_ready = true;
        emit infoChanged();
    });
    connect(proc, &QProcess::errorOccurred, this, [this, proc](QProcess::ProcessError error) {
        if (error != QProcess::FailedToStart)
            return;
        proc->deleteLater();
        m_loading = false;
        m_ready = false;
        m_setupError = tr("Couldn't start Node.js (%1).").arg(proc->program());
        emit infoChanged();
    });
    proc->start();
#endif
}

// --- run -----------------------------------------------------------------------------------------

bool ClaudeAgentController::running() const
{
#if QT_CONFIG(process)
    return m_proc && m_proc->state() != QProcess::NotRunning;
#else
    return false;
#endif
}

bool ClaudeAgentController::projectHasUnsavedChanges() const
{
    return m_app && m_app->projectFile() && m_app->projectFile()->hasUnsavedChanges();
}

void ClaudeAgentController::setState(const QString &state)
{
    if (m_state == state)
        return;
    m_state = state;
    // canRequestChanges depends on the state as well as on the process.
    emit stateChanged();
    emit runningChanged();
}

bool ClaudeAgentController::start(const QString &skill, const QString &source, const QString &note,
                                  const QString &model, const QString &effort)
{
#if !QT_CONFIG(process)
    Q_UNUSED(skill);
    Q_UNUSED(source);
    Q_UNUSED(note);
    Q_UNUSED(model);
    Q_UNUSED(effort);
    return false;
#else
    if (running())
        return false;
    const Launch launch = resolveLaunch();
    m_log.clear();
    m_toolRows.clear();
    m_storyboard.clear();
    m_report.clear();
    m_errorText.clear();
    m_costUsd = 0;
    m_runFolder.clear();
    m_projectPath.clear();
    m_cancelled = false;
    m_stdoutBuffer.clear();
    m_stderrTail.clear();
    m_liveTokens = 0;
    m_liveCost = 0;
    m_costEstimated = false;
    m_runStartedAt = QDateTime::currentMSecsSinceEpoch();
    emit usageChanged();
    emit logChanged();
    emit storyboardChanged();
    if (!launch.error.isEmpty()) {
        m_errorText = launch.error;
        setState(QStringLiteral("failed"));
        emit detailsChanged();
        return false;
    }

    // The helper finds this editor by pid through the session registry, which only lists
    // instances whose MCP server is up.
    McpController *mcp = m_app ? m_app->mcp() : nullptr;
    if (mcp && !mcp->running())
        mcp->setEnabled(true);
    if (!mcp || !mcp->running()) {
        m_errorText = tr("Couldn't turn on Agent access: %1").arg(mcp ? mcp->error() : tr("unavailable"));
        setState(QStringLiteral("failed"));
        emit detailsChanged();
        return false;
    }

    QStringList args = launch.args;
    args << QStringLiteral("run") << QStringLiteral("--json") << QStringLiteral("--yes")
         << QStringLiteral("--pid") << QString::number(QCoreApplication::applicationPid())
         << QStringLiteral("--skill") << skill << QStringLiteral("--source") << source;
    if (!note.trimmed().isEmpty())
        args << QStringLiteral("--note") << note.trimmed();
    if (!model.isEmpty())
        args << QStringLiteral("--model") << model;
    if (!effort.isEmpty())
        args << QStringLiteral("--effort") << effort;

    auto *proc = new QProcess(this);
    m_proc = proc;
    proc->setWorkingDirectory(launch.workDir);
    proc->setProgram(launch.program);
    proc->setArguments(args);
    QProcessEnvironment env = QProcessEnvironment::systemEnvironment();
    env.insert(QStringLiteral("NO_COLOR"), QStringLiteral("1"));
    proc->setProcessEnvironment(env);

    connect(proc, &QProcess::readyReadStandardOutput, this, [this, proc]() {
        m_stdoutBuffer += proc->readAllStandardOutput();
        qsizetype nl;
        while ((nl = m_stdoutBuffer.indexOf('\n')) >= 0) {
            const QByteArray line = m_stdoutBuffer.left(nl);
            m_stdoutBuffer.remove(0, nl + 1);
            handleLine(line);
        }
    });
    connect(proc, &QProcess::readyReadStandardError, this, [this, proc]() {
        // Kept only to explain a crash; the helper reports its own errors as events.
        m_stderrTail += proc->readAllStandardError();
        if (m_stderrTail.size() > 4000)
            m_stderrTail = m_stderrTail.right(4000);
    });
    connect(proc, &QProcess::finished, this, [this](int exitCode, QProcess::ExitStatus) { onFinished(exitCode); });
    connect(proc, &QProcess::errorOccurred, this, [this, proc](QProcess::ProcessError error) {
        if (error != QProcess::FailedToStart)
            return;
        m_errorText = tr("Couldn't start Node.js (%1).").arg(proc->program());
        proc->deleteLater();
        setState(QStringLiteral("failed"));
    });

    m_runModel = model;
    m_runEffort = effort;
    emit runModelChanged();
    m_statusText = tr("Starting…");
    setState(QStringLiteral("planning"));
    emit detailsChanged();
    proc->start();
    emit runningChanged();
    return true;
#endif
}

bool ClaudeAgentController::send(const QVariantMap &command)
{
#if QT_CONFIG(process)
    if (!running())
        return false;
    m_proc->write(QJsonDocument(QJsonObject::fromVariantMap(command)).toJson(QJsonDocument::Compact) + '\n');
    return true;
#else
    Q_UNUSED(command)
    return false;
#endif
}

void ClaudeAgentController::approve(const QVariantMap &storyboard, const QString &model, const QString &effort)
{
    if (m_state != QLatin1String("review"))
        return;
    QVariantMap cmd{{QStringLiteral("type"), QStringLiteral("approve")}};
    if (!storyboard.isEmpty())
        cmd.insert(QStringLiteral("storyboard"), storyboard);
    if (!model.isEmpty())
        cmd.insert(QStringLiteral("model"), model);
    if (!effort.isEmpty())
        cmd.insert(QStringLiteral("effort"), effort);
    if (send(cmd)) {
        m_statusText = tr("Building…");
        setState(QStringLiteral("building"));
        emit detailsChanged();
    }
}

void ClaudeAgentController::revise(const QString &note)
{
    if (m_state != QLatin1String("review") || note.trimmed().isEmpty())
        return;
    if (send({{QStringLiteral("type"), QStringLiteral("revise")}, {QStringLiteral("note"), note.trimmed()}})) {
        appendLog(QStringLiteral("status"), tr("You asked for changes: %1").arg(note.trimmed()));
        m_statusText = tr("Revising the storyboard…");
        setState(QStringLiteral("planning"));
        emit detailsChanged();
    }
}

void ClaudeAgentController::setRunModel(const QString &model, const QString &effort)
{
    QVariantMap cmd{{QStringLiteral("type"), QStringLiteral("set_model")}};
    if (!model.isEmpty())
        cmd.insert(QStringLiteral("model"), model);
    if (!effort.isEmpty())
        cmd.insert(QStringLiteral("effort"), effort);
    send(cmd);
}

void ClaudeAgentController::cancel()
{
#if QT_CONFIG(process)
    if (!running())
        return;
    m_cancelled = true;
    m_statusText = tr("Stopping…");
    emit detailsChanged();
    send({{QStringLiteral("type"), QStringLiteral("cancel")}});
    // The helper stops at the next safe point; don't let a stuck one linger.
    QPointer<QProcess> proc = m_proc;
    QTimer::singleShot(8000, this, [proc]() {
        if (proc && proc->state() != QProcess::NotRunning)
            proc->kill();
    });
#endif
}

bool ClaudeAgentController::canRequestChanges() const
{
    return m_state == QLatin1String("done") && running();
}

void ClaudeAgentController::requestChanges(const QString &note)
{
    if (!canRequestChanges() || note.trimmed().isEmpty())
        return;
    if (send({{QStringLiteral("type"), QStringLiteral("change")}, {QStringLiteral("note"), note.trimmed()}})) {
        appendLog(QStringLiteral("status"), tr("You asked for changes: %1").arg(note.trimmed()));
        m_statusText = tr("Making your changes…");
        setState(QStringLiteral("building"));
        emit detailsChanged();
    }
}

void ClaudeAgentController::reset()
{
#if QT_CONFIG(process)
    if (running()) {
        // Only a finished run, waiting for changes, can be closed from here; it ends itself on
        // "finish". Its exit no longer concerns the panel, which is back at the form.
        if (m_state != QLatin1String("done"))
            return;
        QPointer<QProcess> proc = m_proc;
        proc->disconnect(this);
        send({{QStringLiteral("type"), QStringLiteral("finish")}});
        proc->closeWriteChannel();
        connect(proc, &QProcess::finished, proc, &QObject::deleteLater);
        QTimer::singleShot(10000, proc, [proc]() {
            if (proc && proc->state() != QProcess::NotRunning)
                proc->kill();
        });
        m_proc = nullptr;
        emit runningChanged();
    }
#endif
    m_log.clear();
    m_toolRows.clear();
    m_storyboard.clear();
    m_errorText.clear();
    m_report.clear();
    m_statusText.clear();
    emit logChanged();
    emit storyboardChanged();
    setState(QStringLiteral("idle"));
    emit detailsChanged();
}

void ClaudeAgentController::onFinished(int exitCode)
{
    if (!m_stdoutBuffer.isEmpty()) {
        handleLine(m_stdoutBuffer);
        m_stdoutBuffer.clear();
    }
    if (m_proc)
        m_proc->deleteLater();

    // Close any tool rows still spinning.
    for (int row : std::as_const(m_toolRows)) {
        if (row < m_log.size()) {
            QVariantMap entry = m_log[row].toMap();
            if (entry.value(QStringLiteral("pending")).toBool()) {
                entry.insert(QStringLiteral("pending"), false);
                m_log[row] = entry;
            }
        }
    }
    emit logChanged();

    if (m_state == QLatin1String("done") && !m_cancelled) {
        // A finished run whose session has now closed; nothing to change in the result.
    } else if (m_state == QLatin1String("building") && exitCode == 0 && !m_cancelled) {
        m_statusText = tr("Done");
        setState(QStringLiteral("done"));
    } else if (m_cancelled) {
        m_statusText = tr("Stopped");
        m_errorText = m_state == QLatin1String("building")
                          ? tr("Stopped while building. What was built so far is on the timeline; Undo removes it step by step.")
                          : tr("Stopped before building. Nothing was added to the timeline.");
        setState(QStringLiteral("failed"));
    } else if (m_state != QLatin1String("done")) {
        if (m_errorText.isEmpty()) {
            const QString tail = QString::fromUtf8(m_stderrTail).trimmed().right(600);
            m_errorText = tail.isEmpty() ? tr("drift-agent stopped unexpectedly (exit %1).").arg(exitCode) : tail;
        }
        m_statusText = tr("Failed");
        setState(QStringLiteral("failed"));
    }
    emit detailsChanged();
    // The process is gone: no more changes can be requested, whatever the state.
    emit runningChanged();
}

// --- protocol ------------------------------------------------------------------------------------

void ClaudeAgentController::handleLine(const QByteArray &line)
{
    const QByteArray trimmed = line.trimmed();
    if (trimmed.isEmpty() || trimmed.front() != '{')
        return;
    const QJsonDocument doc = QJsonDocument::fromJson(trimmed);
    if (doc.isObject())
        handleEvent(doc.object().toVariantMap());
}

void ClaudeAgentController::appendLog(const QString &kind, const QString &text, const QString &detail, const QString &id)
{
    if (m_log.size() >= kMaxLogRows) {
        m_log.removeFirst();
        // Row numbers shift with the removal.
        for (auto it = m_toolRows.begin(); it != m_toolRows.end();)
            it = (--it.value() < 0) ? m_toolRows.erase(it) : std::next(it);
    }
    QVariantMap entry{
        {QStringLiteral("kind"), kind},
        {QStringLiteral("text"), text},
        {QStringLiteral("detail"), detail},
        {QStringLiteral("time"), QDateTime::currentMSecsSinceEpoch()},
        {QStringLiteral("pending"), kind == QLatin1String("tool")},
        {QStringLiteral("ok"), kind != QLatin1String("error") && kind != QLatin1String("denied")},
    };
    if (!id.isEmpty())
        m_toolRows.insert(id, m_log.size());
    m_log.append(entry);
    emit logChanged();
}

void ClaudeAgentController::handleEvent(const QVariantMap &e)
{
    const QString type = str(e, "type");
    const QString phase = str(e, "phase");

    if (type == QLatin1String("status")) {
        m_statusText = str(e, "message");
        appendLog(QStringLiteral("status"), m_statusText);
        emit detailsChanged();
    } else if (type == QLatin1String("session")) {
        appendLog(QStringLiteral("status"), tr("Connected · %1").arg(str(e, "model")));
    } else if (type == QLatin1String("model")) {
        m_runModel = str(e, "model");
        m_runEffort = str(e, "effort");
        emit runModelChanged();
    } else if (type == QLatin1String("text")) {
        const QString text = str(e, "text").trimmed();
        if (!text.isEmpty())
            appendLog(QStringLiteral("text"), text);
    } else if (type == QLatin1String("tool")) {
        appendLog(QStringLiteral("tool"), str(e, "name"), str(e, "summary"), str(e, "id"));
    } else if (type == QLatin1String("tool_result")) {
        const auto it = m_toolRows.constFind(str(e, "id"));
        if (it != m_toolRows.constEnd() && it.value() < m_log.size()) {
            QVariantMap entry = m_log[it.value()].toMap();
            const bool ok = e.value(QStringLiteral("ok")).toBool();
            entry.insert(QStringLiteral("pending"), false);
            entry.insert(QStringLiteral("ok"), ok);
            if (!ok)
                entry.insert(QStringLiteral("detail"), str(e, "summary"));
            m_log[it.value()] = entry;
            emit logChanged();
        }
    } else if (type == QLatin1String("denied")) {
        appendLog(QStringLiteral("denied"), str(e, "name"), str(e, "reason"));
    } else if (type == QLatin1String("storyboard")) {
        m_storyboard = e.value(QStringLiteral("storyboard")).toMap();
        const QString file = str(e, "file");
        if (!file.isEmpty())
            m_runFolder = QFileInfo(file).absolutePath();
        emit storyboardChanged();
        m_statusText = tr("Review the storyboard");
        setState(QStringLiteral("review"));
        emit detailsChanged();
    } else if (type == QLatin1String("done")) {
        m_costUsd += e.value(QStringLiteral("costUsd")).toDouble();
        if (phase == QLatin1String("build"))
            m_report = str(e, "result");
        emit detailsChanged();
    } else if (type == QLatin1String("usage")) {
        m_liveTokens = e.value(QStringLiteral("tokens")).toLongLong();
        const QVariant cost = e.value(QStringLiteral("costUsd"));
        m_liveCost = cost.isNull() ? -1.0 : cost.toDouble();
        m_costEstimated = e.value(QStringLiteral("estimated")).toBool();
        emit usageChanged();
    } else if (type == QLatin1String("ready_for_changes")) {
        // The build (or a round of changes) is done; the helper waits for more.
        m_projectPath = str(e, "projectPath");
        m_statusText = tr("Done");
        setState(QStringLiteral("done"));
        emit detailsChanged();
    } else if (type == QLatin1String("finished")) {
        m_projectPath = str(e, "projectPath");
        if (m_runFolder.isEmpty())
            m_runFolder = str(e, "runDir");
        emit detailsChanged();
    } else if (type == QLatin1String("error")) {
        m_errorText = str(e, "message");
        appendLog(QStringLiteral("error"), m_errorText);
        emit detailsChanged();
    }
}

// --- skills --------------------------------------------------------------------------------------

QVariantMap ClaudeAgentController::skillByName(const QString &name) const
{
    for (const QVariant &v : m_skills) {
        const QVariantMap s = v.toMap();
        if (str(s, "name") == name)
            return s;
    }
    return {};
}

void ClaudeAgentController::runSkillCommand(const QStringList &args, bool openAfter)
{
#if QT_CONFIG(process)
    if (m_skillProc)
        return;
    const Launch launch = resolveLaunch();
    if (!launch.error.isEmpty()) {
        m_skillMessage = launch.error;
        m_skillMessageIsError = true;
        emit skillChanged();
        return;
    }
    auto *proc = new QProcess(this);
    m_skillProc = proc;
    m_skillMessage.clear();
    emit skillChanged();
    proc->setWorkingDirectory(launch.workDir);
    proc->setProgram(launch.program);
    proc->setArguments(launch.args + QStringList{QStringLiteral("skill")} + args + QStringList{QStringLiteral("--json")});
    connect(proc, &QProcess::finished, this, [this, proc, openAfter](int, QProcess::ExitStatus) {
        QVariantMap reply;
        for (const QByteArray &line : proc->readAllStandardOutput().split('\n')) {
            const QJsonDocument doc = QJsonDocument::fromJson(line.trimmed());
            if (doc.isObject())
                reply = doc.object().toVariantMap();
        }
        const QString err = QString::fromUtf8(proc->readAllStandardError()).trimmed();
        proc->deleteLater();
        m_skillProc = nullptr;
        const bool ok = reply.value(QStringLiteral("ok")).toBool();
        m_skillMessageIsError = !ok;
        if (!ok) {
            m_skillMessage = reply.contains(QStringLiteral("error")) ? str(reply, "error") : err.right(300);
        } else {
            const QVariantMap skill = reply.value(QStringLiteral("skill")).toMap();
            if (reply.contains(QStringLiteral("trashedTo")))
                m_skillMessage = tr("Moved to %1").arg(QDir::toNativeSeparators(str(reply, "trashedTo")));
            else if (openAfter && !skill.isEmpty())
                m_skillMessage = tr("Opened %1. Save it, then reload.").arg(QDir::toNativeSeparators(str(skill, "file")));
            else
                m_skillMessage.clear();
            if (openAfter && !skill.isEmpty()) {
                const QUrl file = QUrl::fromLocalFile(str(skill, "file"));
                if (!QDesktopServices::openUrl(file))
                    QDesktopServices::openUrl(QUrl::fromLocalFile(str(skill, "dir")));
            }
        }
        emit skillChanged();
        refresh();
    });
    proc->start();
#else
    Q_UNUSED(args);
    Q_UNUSED(openAfter);
#endif
}

void ClaudeAgentController::createSkill(const QString &name, const QString &description, const QStringList &sources)
{
    QStringList args{QStringLiteral("new"), name.trimmed(), QStringLiteral("--description"), description.trimmed()};
    if (!sources.isEmpty())
        args << QStringLiteral("--sources") << sources.join(QLatin1Char(','));
    runSkillCommand(args, true);
}

void ClaudeAgentController::customizeSkill(const QString &name)
{
    runSkillCommand({QStringLiteral("customize"), name}, true);
}

void ClaudeAgentController::removeSkill(const QString &name)
{
    runSkillCommand({QStringLiteral("remove"), name}, false);
}

void ClaudeAgentController::setSkillEnabled(const QString &name, bool enabled)
{
    runSkillCommand({enabled ? QStringLiteral("enable") : QStringLiteral("disable"), name}, false);
}

void ClaudeAgentController::editSkill(const QString &name) const
{
    const QVariantMap s = skillByName(name);
    if (s.isEmpty())
        return;
    if (!QDesktopServices::openUrl(QUrl::fromLocalFile(str(s, "file"))))
        QDesktopServices::openUrl(QUrl::fromLocalFile(str(s, "dir")));
}

void ClaudeAgentController::openSkillFolder(const QString &name) const
{
    const QVariantMap s = skillByName(name);
    if (!s.isEmpty())
        QDesktopServices::openUrl(QUrl::fromLocalFile(str(s, "dir")));
}

// --- helpers -------------------------------------------------------------------------------------

void ClaudeAgentController::login()
{
#if QT_CONFIG(process)
    const Launch launch = resolveLaunch();
    if (!launch.error.isEmpty()) {
        m_setupError = launch.error;
        emit infoChanged();
        return;
    }
    QProcess proc;
    proc.setWorkingDirectory(launch.workDir);
    proc.setProgram(launch.program);
    proc.setArguments(launch.args + QStringList{QStringLiteral("login")});
#ifdef Q_OS_WIN
    // Its own console: the sign-in prints a link and may ask for a code.
    proc.setCreateProcessArgumentsModifier([](QProcess::CreateProcessArguments *a) {
        a->flags |= CREATE_NEW_CONSOLE;
    });
    proc.startDetached();
#else
    // No portable way to open a terminal; say what to run instead.
    m_setupError = tr("Run \"npm start -- login\" in %1, then refresh.").arg(launch.workDir);
    emit infoChanged();
#endif
#endif
}

void ClaudeAgentController::openRunFolder() const
{
    if (!m_runFolder.isEmpty())
        QDesktopServices::openUrl(QUrl::fromLocalFile(m_runFolder));
}

void ClaudeAgentController::openSkillsFolder() const
{
    const QString dir = m_userSkillsDir.isEmpty() ? QDir::home().filePath(QStringLiteral(".drift-agent/skills")) : m_userSkillsDir;
    QDir().mkpath(dir);
    QDesktopServices::openUrl(QUrl::fromLocalFile(dir));
}

QString ClaudeAgentController::localPath(const QUrl &url) const
{
    return url.isLocalFile() ? QDir::toNativeSeparators(url.toLocalFile()) : url.toString();
}
