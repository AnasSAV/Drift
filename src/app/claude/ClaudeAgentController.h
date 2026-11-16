#pragma once

#include <QHash>
#include <QObject>
#include <QPointer>
#include <QString>
#include <QStringList>
#include <QUrl>
#include <QVariantList>
#include <QVariantMap>

class AppController;
class QProcess;

// The Claude panel's back end: runs the drift-agent helper (agent/ in this repo, a Node program
// built on the Claude Agent SDK) as a child process and turns its JSON-lines protocol into QML
// properties.
//
// A run: start() → the helper plans (state "planning") → it proposes a storyboard ("review") →
// approve() or revise() → it builds on this editor's timeline through the MCP server ("building")
// → "done" or "failed". The helper reaches this instance by pid, so start() switches Agent access
// on first. The protocol is documented in agent/README.md ("JSON mode").
//
// Reached from QML as the ClaudeAgent singleton.
class ClaudeAgentController : public QObject
{
    Q_OBJECT

    // Setup: where the helper lives and which Node runs it. Empty means auto-detect; both persist.
    Q_PROPERTY(QString agentDir READ agentDir WRITE setAgentDir NOTIFY setupChanged)
    Q_PROPERTY(QString nodePath READ nodePath WRITE setNodePath NOTIFY setupChanged)
    Q_PROPERTY(QString resolvedAgentDir READ resolvedAgentDir NOTIFY setupChanged)

    // What `drift-agent info` reported. ready is false until it has answered once.
    Q_PROPERTY(bool loading READ loading NOTIFY infoChanged)
    Q_PROPERTY(bool ready READ ready NOTIFY infoChanged)
    Q_PROPERTY(QString setupError READ setupError NOTIFY infoChanged)
    Q_PROPERTY(QVariantList skills READ skills NOTIFY infoChanged)
    Q_PROPERTY(QVariantList models READ models NOTIFY infoChanged)
    Q_PROPERTY(QStringList efforts READ efforts NOTIFY infoChanged)
    Q_PROPERTY(QString defaultModel READ defaultModel NOTIFY infoChanged)
    Q_PROPERTY(QString defaultEffort READ defaultEffort NOTIFY infoChanged)
    Q_PROPERTY(bool loggedIn READ loggedIn NOTIFY infoChanged)
    Q_PROPERTY(QString account READ account NOTIFY infoChanged)
    Q_PROPERTY(QString userSkillsDir READ userSkillsDir NOTIFY infoChanged)

    // The run. state: idle | planning | review | building | done | failed
    Q_PROPERTY(QString state READ state NOTIFY stateChanged)
    Q_PROPERTY(bool running READ running NOTIFY stateChanged)
    Q_PROPERTY(QString statusText READ statusText NOTIFY stateChanged)
    Q_PROPERTY(QString errorText READ errorText NOTIFY stateChanged)
    Q_PROPERTY(QString report READ report NOTIFY stateChanged)
    Q_PROPERTY(double costUsd READ costUsd NOTIFY stateChanged)
    Q_PROPERTY(QString runFolder READ runFolder NOTIFY stateChanged)
    Q_PROPERTY(QString projectPath READ projectPath NOTIFY stateChanged)
    Q_PROPERTY(QString runModel READ runModel NOTIFY runModelChanged)
    Q_PROPERTY(QString runEffort READ runEffort NOTIFY runModelChanged)
    // Activity entries: {kind: status|text|tool|denied|error, text, detail, pending, ok, time}
    Q_PROPERTY(QVariantList log READ log NOTIFY logChanged)
    // The storyboard awaiting review (agent/src/storyboard.ts shape), empty otherwise.
    Q_PROPERTY(QVariantMap storyboard READ storyboard NOTIFY storyboardChanged)

public:
    explicit ClaudeAgentController(AppController *app, QObject *parent = nullptr);
    ~ClaudeAgentController() override;

    QString agentDir() const { return m_agentDir; }
    void setAgentDir(const QString &dir);
    QString nodePath() const { return m_nodePath; }
    void setNodePath(const QString &path);
    QString resolvedAgentDir() const;

    bool loading() const { return m_loading; }
    bool ready() const { return m_ready; }
    QString setupError() const { return m_setupError; }
    QVariantList skills() const { return m_skills; }
    QVariantList models() const { return m_models; }
    QStringList efforts() const { return m_efforts; }
    QString defaultModel() const { return m_defaultModel; }
    QString defaultEffort() const { return m_defaultEffort; }
    bool loggedIn() const { return m_loggedIn; }
    QString account() const { return m_account; }
    QString userSkillsDir() const { return m_userSkillsDir; }

    QString state() const { return m_state; }
    bool running() const;
    QString statusText() const { return m_statusText; }
    QString errorText() const { return m_errorText; }
    QString report() const { return m_report; }
    double costUsd() const { return m_costUsd; }
    QString runFolder() const { return m_runFolder; }
    QString projectPath() const { return m_projectPath; }
    QString runModel() const { return m_runModel; }
    QString runEffort() const { return m_runEffort; }
    QVariantList log() const { return m_log; }
    QVariantMap storyboard() const { return m_storyboard; }

    // Re-reads skills, models and login (`drift-agent info`). Free: nothing is sent to a model.
    Q_INVOKABLE void refresh();
    // A run starts a new project; the panel asks before throwing away unsaved work.
    Q_INVOKABLE bool projectHasUnsavedChanges() const;
    Q_INVOKABLE bool start(const QString &skill, const QString &source, const QString &note,
                           const QString &model, const QString &effort);
    // Build the storyboard (as edited in the panel) with this model and effort.
    Q_INVOKABLE void approve(const QVariantMap &storyboard, const QString &model, const QString &effort);
    Q_INVOKABLE void revise(const QString &note);
    // Switches the model for the rest of the run; applies from the helper's next turn.
    Q_INVOKABLE void setRunModel(const QString &model, const QString &effort);
    Q_INVOKABLE void cancel();
    // Back to the form after a run has finished.
    Q_INVOKABLE void reset();

    // Opens Claude's sign-in in a console window (it opens the browser). refresh() afterwards.
    Q_INVOKABLE void login();
    Q_INVOKABLE void openRunFolder() const;
    Q_INVOKABLE void openSkillsFolder() const;
    Q_INVOKABLE QString localPath(const QUrl &url) const;

signals:
    void setupChanged();
    void infoChanged();
    void stateChanged();
    void runModelChanged();
    void logChanged();
    void storyboardChanged();

private:
    struct Launch
    {
        QString program;
        QStringList args; // before the helper's own command
        QString workDir;
        QString error;
    };
    Launch resolveLaunch() const;
    QString resolveNode() const;

    void setState(const QString &state);
    void handleLine(const QByteArray &line);
    void handleEvent(const QVariantMap &event);
    void onFinished(int exitCode);
    void appendLog(const QString &kind, const QString &text, const QString &detail = QString(),
                   const QString &id = QString());
    bool send(const QVariantMap &command);

    AppController *m_app = nullptr;
    QString m_agentDir;
    QString m_nodePath;

    QPointer<QProcess> m_infoProc;
    bool m_loading = false;
    bool m_ready = false;
    QString m_setupError;
    QVariantList m_skills;
    QVariantList m_models;
    QStringList m_efforts;
    QString m_defaultModel;
    QString m_defaultEffort;
    bool m_loggedIn = false;
    QString m_account;
    QString m_userSkillsDir;

    QPointer<QProcess> m_proc;
    QByteArray m_stdoutBuffer;
    QByteArray m_stderrTail;
    bool m_cancelled = false;
    QString m_state = QStringLiteral("idle");
    QString m_statusText;
    QString m_errorText;
    QString m_report;
    double m_costUsd = 0;
    QString m_runFolder;
    QString m_projectPath;
    QString m_runModel;
    QString m_runEffort;
    QVariantList m_log;
    QHash<QString, int> m_toolRows; // tool_use id → row in m_log
    QVariantMap m_storyboard;
};
