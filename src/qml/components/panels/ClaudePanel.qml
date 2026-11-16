import QtQuick
import QtQuick.Controls.Basic
import Drift

// Claude builds a video from a document, video, folder or repo (agent/ in this repo; back end in
// src/app/claude/ClaudeAgentController). Pick a skill and a source, review and edit the storyboard
// Claude proposes, then it builds the timeline; what it builds is ordinary clips to keep editing.
PanelFrame {
    id: root

    readonly property string st: ClaudeAgent.state
    readonly property bool working: st === "planning" || st === "building"
    // The storyboard as the user edits it; refreshed whenever Claude proposes a new one.
    property var draft: ({})
    property int draftRev: 0
    property bool showLog: false
    // The skill manager replaces the form while open.
    property bool managing: false
    readonly property var enabledSkills: ClaudeAgent.skills.filter(s => s.enabled !== false)
    // Ticks once a second while Claude works, for the elapsed time.
    property double now: Date.now()
    // The skill a Remove button asked about (inline components reach the dialog through these).
    property string pendingRemoval: ""
    function openRemoveDialog() { removeDialog.open() }

    Timer {
        interval: 1000
        repeat: true
        running: root.working
        onTriggered: root.now = Date.now()
    }

    function copy(v) { return JSON.parse(JSON.stringify(v)) }
    function tokensText(n) {
        return n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : (n >= 1000 ? Math.round(n / 1000) + "k" : String(n))
    }
    function costText() {
        if (ClaudeAgent.liveCost < 0) return ""
        return (ClaudeAgent.costEstimated ? "≈ " : "") + "$" + ClaudeAgent.liveCost.toFixed(2)
    }
    // "$0.42 · 128k tokens · 2:05" for the run so far.
    function usageText() {
        const parts = []
        const c = root.costText()
        if (c.length > 0) parts.push(c)
        if (ClaudeAgent.liveTokens > 0) parts.push(qsTr("%1 tokens").arg(root.tokensText(ClaudeAgent.liveTokens)))
        if (ClaudeAgent.runStartedAt > 0) parts.push(root.fmtTime(Math.max(0, (root.now - ClaudeAgent.runStartedAt) / 1000)))
        return parts.join(" · ")
    }
    function touch() { root.draftRev++ }
    function total(sb) {
        let t = 0
        for (const s of (sb.scenes || [])) t += Number(s.durationSec) || 0
        return t
    }
    function fmtTime(sec) {
        // Whole seconds first, so 59.6 s reads 1:00, not 0:60.
        const total = Math.round(sec)
        const m = Math.floor(total / 60)
        const s = total - m * 60
        return m + ":" + (s < 10 ? "0" : "") + s
    }
    function indexOfId(list, key, value) {
        for (let i = 0; i < list.length; ++i)
            if (list[i][key] === value) return i
        return -1
    }

    Connections {
        target: ClaudeAgent
        function onStoryboardChanged() {
            root.draft = root.copy(ClaudeAgent.storyboard)
            root.touch()
        }
    }

    Component.onCompleted: if (!ClaudeAgent.ready && !ClaudeAgent.loading) ClaudeAgent.refresh()

    AssetsPanelHeader {
        id: header
        width: parent.width
        height: Theme.panelHeaderHeight
        title: qsTr("Claude")
    }

    // --- status line ------------------------------------------------------------------------------
    Item {
        id: status
        anchors.top: header.bottom
        width: parent.width
        height: 36

        Rectangle {
            id: dot
            anchors.left: parent.left
            anchors.leftMargin: Theme.pagePadding
            anchors.verticalCenter: parent.verticalCenter
            width: 8; height: 8; radius: 4
            color: !ClaudeAgent.ready ? Theme.mutedForeground
                   : (!ClaudeAgent.loggedIn ? Theme.warning
                      : (root.st === "failed" ? Theme.destructive : Theme.constructive))
            SequentialAnimation on opacity {
                running: root.working || ClaudeAgent.loading
                loops: Animation.Infinite
                NumberAnimation { to: 0.25; duration: 500 }
                NumberAnimation { to: 1; duration: 500 }
                onRunningChanged: if (!running) dot.opacity = 1
            }
        }

        Text {
            anchors.left: dot.right
            anchors.leftMargin: Theme.spacingSm
            anchors.right: statusButtons.left
            anchors.rightMargin: Theme.spacingSm
            anchors.verticalCenter: parent.verticalCenter
            elide: Text.ElideRight
            color: Theme.mutedForeground
            font.family: Theme.fontFamily
            font.pixelSize: Theme.fontSizeXs
            text: {
                if (root.managing) return qsTr("Skills")
                if (root.working || root.st === "review" || root.st === "done") {
                    const u = root.usageText()
                    return ClaudeAgent.statusText + (u.length > 0 ? " · " + u : "")
                }
                if (ClaudeAgent.loading) return qsTr("Checking Claude…")
                if (!ClaudeAgent.ready) return qsTr("Not set up")
                if (!ClaudeAgent.loggedIn) return qsTr("Not logged in to Claude")
                return ClaudeAgent.account
            }
        }

        Row {
            id: statusButtons
            anchors.right: parent.right
            anchors.rightMargin: Theme.spacingSm
            anchors.verticalCenter: parent.verticalCenter
            spacing: Theme.spacingXs

            IconButton {
                visible: ClaudeAgent.ready && !ClaudeAgent.loggedIn
                glyph: Theme.icons.link
                text: qsTr("Log in")
                tooltip: qsTr("Sign in to Claude in a console window, then refresh")
                onClicked: ClaudeAgent.login()
            }
            IconButton {
                glyph: Theme.icons.wand
                active: root.managing
                tooltip: root.managing ? qsTr("Back") : qsTr("Manage skills: create, customize, enable or remove")
                enabled: ClaudeAgent.ready && root.st === "idle"
                onClicked: root.managing = !root.managing
            }
            IconButton {
                glyph: Theme.icons.refresh
                tooltip: qsTr("Reload skills, models and login")
                enabled: !ClaudeAgent.loading && !root.working
                onClicked: ClaudeAgent.refresh()
            }
        }
    }

    Rectangle {
        id: rule
        anchors.top: status.bottom
        width: parent.width
        height: Theme.borderWidth
        color: Theme.panelBorder
    }

    // --- not set up ---------------------------------------------------------------------------------
    EmptyState {
        anchors.top: rule.bottom
        anchors.bottom: parent.bottom
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.margins: Theme.spacingLg
        visible: !ClaudeAgent.ready
        glyph: Theme.icons.bot
        glyphSpinning: ClaudeAgent.loading
        title: ClaudeAgent.loading ? qsTr("Checking Claude…") : qsTr("Claude isn't set up yet")
        hint: ClaudeAgent.loading ? "" : ClaudeAgent.setupError
        actionText: ClaudeAgent.loading ? "" : qsTr("Choose the agent folder…")
        onActionTriggered: {
            const url = FileDialogs.openDirectory(qsTr("Choose the drift-agent folder"))
            if (url.toString().length > 0) ClaudeAgent.agentDir = ClaudeAgent.localPath(url)
        }
    }

    // --- content ---------------------------------------------------------------------------------------
    Flickable {
        id: scroller
        anchors.top: rule.bottom
        anchors.bottom: footer.top
        anchors.left: parent.left
        anchors.right: parent.right
        visible: ClaudeAgent.ready
        clip: true
        contentWidth: width
        contentHeight: body.implicitHeight + 2 * Theme.pagePadding
        boundsBehavior: Flickable.StopAtBounds
        ScrollBar.vertical: AppScrollBar {}

        Column {
            id: body
            x: Theme.pagePadding
            y: Theme.pagePadding
            width: scroller.width - 2 * Theme.pagePadding
            spacing: Theme.spacingMd

            // ===== skill manager =====
            Column {
                id: manager
                width: parent.width
                spacing: Theme.spacingMd
                visible: root.managing && root.st === "idle"

                Text {
                    width: parent.width
                    wrapMode: Text.WordWrap
                    color: Theme.mutedForeground
                    font.family: Theme.fontFamily
                    font.pixelSize: Theme.fontSizeXs
                    text: qsTr("A skill is a folder with a SKILL.md: instructions for one kind of video. Edit opens it in your text editor; reload here after saving.")
                }

                // New skill
                Rectangle {
                    width: parent.width
                    height: newCol.implicitHeight + 2 * Theme.spacingSm
                    radius: Theme.radiusMd
                    color: Theme.panelSecondaryBg
                    border.color: Theme.panelSecondaryBorder
                    border.width: Theme.borderWidth

                    Column {
                        id: newCol
                        x: Theme.spacingSm
                        y: Theme.spacingSm
                        width: parent.width - 2 * Theme.spacingSm
                        spacing: Theme.spacingXs

                        FieldLabel { text: qsTr("New skill") }
                        ThemedTextField {
                            id: newName
                            width: parent.width
                            placeholderText: qsTr("name, e.g. product-demo")
                            validator: RegularExpressionValidator { regularExpression: /[a-z0-9-]{0,48}/ }
                        }
                        ThemedTextField {
                            id: newDescription
                            width: parent.width
                            placeholderText: qsTr("What it makes, in one sentence")
                        }
                        Flow {
                            width: parent.width
                            spacing: Theme.spacingSm
                            Repeater {
                                id: newSources
                                model: [
                                    { id: "document", label: qsTr("Documents") },
                                    { id: "repo", label: qsTr("Repos") },
                                    { id: "video", label: qsTr("Video") },
                                    { id: "url", label: qsTr("Web pages") }
                                ]
                                delegate: ThemedCheckBox {
                                    required property var modelData
                                    property string sourceId: modelData.id
                                    text: modelData.label
                                }
                            }
                        }
                        ThemedButton {
                            width: parent.width
                            variant: "primary"
                            glyph: Theme.icons.plus
                            text: qsTr("Create and edit")
                            enabled: /^[a-z0-9][a-z0-9-]{1,47}$/.test(newName.text) && !ClaudeAgent.skillBusy
                            onClicked: {
                                const sources = []
                                for (let i = 0; i < newSources.count; ++i) {
                                    const box = newSources.itemAt(i)
                                    if (box && box.checked) sources.push(box.sourceId)
                                }
                                ClaudeAgent.createSkill(newName.text, newDescription.text, sources)
                                newName.text = ""
                                newDescription.text = ""
                            }
                        }
                    }
                }

                Text {
                    width: parent.width
                    visible: ClaudeAgent.skillMessage.length > 0
                    wrapMode: Text.WordWrap
                    color: ClaudeAgent.skillMessageIsError ? Theme.destructive : Theme.mutedForeground
                    font.family: Theme.fontFamily
                    font.pixelSize: Theme.fontSizeXs
                    text: ClaudeAgent.skillMessage
                }

                Repeater {
                    model: ClaudeAgent.skills
                    delegate: SkillRow {
                        required property var modelData
                        width: manager.width
                        skill: modelData
                        panel: root
                    }
                }

                // Folders that hold no valid skill.
                Repeater {
                    model: ClaudeAgent.skillProblems
                    delegate: Text {
                        required property var modelData
                        width: manager.width
                        wrapMode: Text.WrapAnywhere
                        color: Theme.warning
                        font.family: Theme.fontFamily
                        font.pixelSize: Theme.fontSizeXs
                        text: "⚠ " + modelData.dir + ": " + modelData.problem
                    }
                }

                ThemedButton {
                    glyph: Theme.icons.folder
                    text: qsTr("Open my skills folder")
                    onClicked: ClaudeAgent.openSkillsFolder()
                }
            }

            // ===== form (idle) =====
            Column {
                id: form
                width: parent.width
                spacing: Theme.spacingMd
                visible: root.st === "idle" && !root.managing

                property var skill: skillBox.currentIndex >= 0 ? root.enabledSkills[skillBox.currentIndex] : null

                FieldLabel { text: qsTr("Skill") }
                ThemedComboBox {
                    id: skillBox
                    width: parent.width
                    model: root.enabledSkills
                    textRole: "name"
                }
                Text {
                    width: parent.width
                    visible: !!form.skill
                    wrapMode: Text.WordWrap
                    color: Theme.mutedForeground
                    font.family: Theme.fontFamily
                    font.pixelSize: Theme.fontSizeXs
                    text: form.skill ? form.skill.description
                          + (form.skill.sources.length ? "\n" + qsTr("For: %1").arg(form.skill.sources.join(", ")) : "") : ""
                }

                FieldLabel { text: qsTr("Source") }
                Row {
                    width: parent.width
                    spacing: Theme.spacingXs
                    ThemedTextField {
                        id: sourceField
                        width: parent.width - fileBtn.width - folderBtn.width - 2 * parent.spacing
                        placeholderText: qsTr("File, folder, git URL or web page")
                    }
                    IconButton {
                        id: fileBtn
                        anchors.verticalCenter: parent.verticalCenter
                        glyph: Theme.icons.fileText
                        tooltip: qsTr("Choose a document or media file")
                        onClicked: {
                            const url = FileDialogs.openFile(qsTr("Choose a source"), [qsTr("All files (*)")])
                            if (url.toString().length > 0) sourceField.text = ClaudeAgent.localPath(url)
                        }
                    }
                    IconButton {
                        id: folderBtn
                        anchors.verticalCenter: parent.verticalCenter
                        glyph: Theme.icons.folder
                        tooltip: qsTr("Choose a folder or code repository")
                        onClicked: {
                            const url = FileDialogs.openDirectory(qsTr("Choose a folder"))
                            if (url.toString().length > 0) sourceField.text = ClaudeAgent.localPath(url)
                        }
                    }
                }

                FieldLabel { text: qsTr("Note (optional)") }
                ThemedTextArea {
                    id: noteField
                    width: parent.width
                    height: Math.max(64, implicitHeight)
                    wrapMode: TextEdit.Wrap
                    placeholderText: qsTr("Length, format, tone, audience… e.g. \"45 seconds, vertical, playful\"")
                }

                Row {
                    width: parent.width
                    spacing: Theme.spacingSm
                    Column {
                        width: (parent.width - parent.spacing) * 0.62
                        spacing: Theme.spacingXs
                        FieldLabel { text: qsTr("Model") }
                        ModelBox { id: modelBox; width: parent.width; initial: form.skill && form.skill.model ? form.skill.model : ClaudeAgent.defaultModel }
                    }
                    Column {
                        width: (parent.width - parent.spacing) * 0.38
                        spacing: Theme.spacingXs
                        FieldLabel { text: qsTr("Effort") }
                        EffortBox { id: effortBox; width: parent.width; initial: form.skill && form.skill.effort ? form.skill.effort : ClaudeAgent.defaultEffort }
                    }
                }

                ThemedButton {
                    width: parent.width
                    variant: "primary"
                    glyph: Theme.icons.sparkles
                    text: qsTr("Plan the video")
                    enabled: !!form.skill && sourceField.text.trim().length > 0 && ClaudeAgent.loggedIn
                    onClicked: {
                        if (ClaudeAgent.projectHasUnsavedChanges()) discardDialog.open()
                        else form.go()
                    }
                }
                Text {
                    width: parent.width
                    wrapMode: Text.WordWrap
                    color: Theme.mutedForeground
                    font.family: Theme.fontFamily
                    font.pixelSize: Theme.fontSizeXs
                    text: qsTr("Claude reads the source and proposes a storyboard first. Nothing is built until you approve it. A run starts a new project.")
                }

                function go() {
                    ClaudeAgent.start(form.skill.name, sourceField.text.trim(), noteField.text,
                                      modelBox.currentValue || "", effortBox.currentText || "")
                }
            }

            // ===== storyboard review =====
            Column {
                id: review
                width: parent.width
                spacing: Theme.spacingMd
                visible: root.st === "review" && !!root.draft.scenes

                ThemedTextField {
                    width: parent.width
                    font.pixelSize: Theme.fontSizeBase
                    font.weight: Font.DemiBold
                    text: root.draftRev >= 0 && root.draft.title ? root.draft.title : ""
                    onEditingFinished: root.draft.title = text
                }
                Text {
                    width: parent.width
                    wrapMode: Text.WordWrap
                    color: Theme.foreground
                    font.family: Theme.fontFamily
                    font.pixelSize: Theme.fontSizeSm
                    text: root.draftRev >= 0 && root.draft.summary ? root.draft.summary : ""
                }
                Text {
                    width: parent.width
                    wrapMode: Text.WordWrap
                    color: Theme.mutedForeground
                    font.family: Theme.fontFamily
                    font.pixelSize: Theme.fontSizeXs
                    text: {
                        if (root.draftRev < 0 || !root.draft.format) return ""
                        const f = root.draft.format
                        return qsTr("%1×%2 · %3 fps · %4 planned (target %5) · voice: %6")
                            .arg(f.width).arg(f.height).arg(f.fps)
                            .arg(root.fmtTime(root.total(root.draft))).arg(root.fmtTime(root.draft.targetDurationSec || 0))
                            .arg(root.draft.voiceover)
                        + (root.draft.style ? "\n" + qsTr("Style: %1").arg(root.draft.style) : "")
                        + (root.draft.notes ? "\n" + qsTr("Notes: %1").arg(root.draft.notes) : "")
                    }
                }

                Repeater {
                    model: root.draftRev >= 0 && root.draft.scenes ? root.draft.scenes.length : 0
                    delegate: SceneCard {
                        panel: root
                        required property int index
                        width: review.width
                        sceneIndex: index
                    }
                }

                // Build
                Rectangle { width: parent.width; height: Theme.borderWidth; color: Theme.panelBorder }
                Row {
                    width: parent.width
                    spacing: Theme.spacingSm
                    ModelBox { id: buildModel; width: (parent.width - parent.spacing) * 0.62; initial: ClaudeAgent.runModel }
                    EffortBox { id: buildEffort; width: (parent.width - parent.spacing) * 0.38; initial: ClaudeAgent.runEffort }
                }
                ThemedButton {
                    width: parent.width
                    variant: "primary"
                    glyph: Theme.icons.play
                    text: qsTr("Build the video")
                    enabled: root.draftRev >= 0 && !!root.draft.scenes && root.draft.scenes.length > 0
                    onClicked: ClaudeAgent.approve(root.copy(root.draft), buildModel.currentValue || "", buildEffort.currentText || "")
                }

                // Revise
                ThemedTextArea {
                    id: reviseField
                    width: parent.width
                    height: Math.max(56, implicitHeight)
                    wrapMode: TextEdit.Wrap
                    placeholderText: qsTr("Or ask Claude for changes, e.g. \"shorter, and open with the demo\"")
                }
                Row {
                    width: parent.width
                    spacing: Theme.spacingSm
                    ThemedButton {
                        width: (parent.width - parent.spacing) / 2
                        glyph: Theme.icons.pencil
                        text: qsTr("Revise")
                        enabled: reviseField.text.trim().length > 0
                        onClicked: { ClaudeAgent.revise(reviseField.text); reviseField.text = "" }
                    }
                    ThemedButton {
                        width: (parent.width - parent.spacing) / 2
                        variant: "ghost"
                        glyph: Theme.icons.x
                        text: qsTr("Discard")
                        onClicked: ClaudeAgent.cancel()
                    }
                }
            }

            // ===== result =====
            Rectangle {
                width: parent.width
                visible: root.st === "done" || root.st === "failed"
                height: resultCol.implicitHeight + 2 * Theme.spacingMd
                radius: Theme.radiusMd
                color: Theme.panelSecondaryBg
                border.color: root.st === "failed" ? Theme.destructive : Theme.panelSecondaryBorder
                border.width: Theme.borderWidth

                Column {
                    id: resultCol
                    x: Theme.spacingMd
                    y: Theme.spacingMd
                    width: parent.width - 2 * Theme.spacingMd
                    spacing: Theme.spacingSm

                    Text {
                        width: parent.width
                        wrapMode: Text.WordWrap
                        color: root.st === "failed" ? Theme.destructive : Theme.constructive
                        font.family: Theme.fontFamily
                        font.pixelSize: Theme.fontSizeSm
                        font.weight: Font.DemiBold
                        text: root.st === "done" ? qsTr("The video is on the timeline. Edit away.")
                                                 : (ClaudeAgent.errorText.length > 0 ? ClaudeAgent.errorText : qsTr("The run stopped."))
                    }
                    Text {
                        width: parent.width
                        visible: ClaudeAgent.report.length > 0
                        wrapMode: Text.WordWrap
                        textFormat: Text.MarkdownText
                        color: Theme.foreground
                        font.family: Theme.fontFamily
                        font.pixelSize: Theme.fontSizeXs
                        text: ClaudeAgent.report
                    }
                    Text {
                        width: parent.width
                        wrapMode: Text.WordWrap
                        color: Theme.mutedForeground
                        font.family: Theme.fontFamily
                        font.pixelSize: Theme.fontSizeXs
                        text: {
                            const parts = []
                            if (ClaudeAgent.liveCost >= 0) parts.push(qsTr("Cost $%1").arg(ClaudeAgent.liveCost.toFixed(2)))
                            else parts.push(qsTr("Cost $%1").arg(ClaudeAgent.costUsd.toFixed(2)))
                            if (ClaudeAgent.liveTokens > 0) parts.push(qsTr("%1 tokens").arg(root.tokensText(ClaudeAgent.liveTokens)))
                            return parts.join(" · ") + (ClaudeAgent.account.indexOf("login") >= 0
                                   ? "  " + qsTr("(API-equivalent; a Claude plan counts it against your usage limits instead)") : "")
                        }
                    }

                    // Another round on the built timeline, while the session is still open.
                    Column {
                        width: parent.width
                        spacing: Theme.spacingXs
                        visible: ClaudeAgent.canRequestChanges

                        FieldLabel { text: qsTr("Changes") }
                        ThemedTextArea {
                            id: changesField
                            width: parent.width
                            height: Math.max(56, implicitHeight)
                            wrapMode: TextEdit.Wrap
                            placeholderText: qsTr("e.g. \"Make the titles bigger and swap scenes 2 and 3\". Your own edits on the timeline are kept.")
                        }
                        ThemedButton {
                            width: parent.width
                            glyph: Theme.icons.pencil
                            text: qsTr("Apply changes")
                            enabled: changesField.text.trim().length > 0
                            onClicked: { ClaudeAgent.requestChanges(changesField.text); changesField.text = "" }
                        }
                    }

                    Row {
                        spacing: Theme.spacingSm
                        ThemedButton {
                            variant: ClaudeAgent.canRequestChanges ? "secondary" : "primary"
                            glyph: ClaudeAgent.canRequestChanges ? Theme.icons.check : Theme.icons.plus
                            text: ClaudeAgent.canRequestChanges ? qsTr("Finish") : qsTr("New video")
                            onClicked: ClaudeAgent.reset()
                        }
                        ThemedButton {
                            visible: ClaudeAgent.runFolder.length > 0
                            glyph: Theme.icons.externalLink
                            text: qsTr("Run folder")
                            onClicked: ClaudeAgent.openRunFolder()
                        }
                    }
                }
            }

            // ===== activity =====
            Column {
                width: parent.width
                spacing: Theme.spacingXs
                visible: root.st !== "idle"

                Row {
                    spacing: Theme.spacingXs
                    IconButton {
                        glyph: (root.working || root.showLog) ? Theme.icons.chevronDown : Theme.icons.chevronRight
                        text: qsTr("Activity (%1)").arg(ClaudeAgent.log.length)
                        enabled: !root.working
                        onClicked: root.showLog = !root.showLog
                    }
                }

                Repeater {
                    model: (root.working || root.showLog) ? ClaudeAgent.log : []
                    delegate: ActivityRow { width: body.width }
                }
            }
        }
    }

    // --- footer: stop while working -------------------------------------------------------------------
    Item {
        id: footer
        anchors.bottom: parent.bottom
        width: parent.width
        height: root.working ? 44 : 0
        visible: root.working

        Rectangle { width: parent.width; height: Theme.borderWidth; color: Theme.panelBorder }
        ThemedButton {
            anchors.centerIn: parent
            variant: "secondary"
            glyph: Theme.icons.square
            text: ClaudeAgent.statusText === qsTr("Stopping…") ? qsTr("Stopping…") : qsTr("Stop")
            onClicked: ClaudeAgent.cancel()
        }
    }

    // Following the log while Claude works.
    Connections {
        target: ClaudeAgent
        function onLogChanged() {
            if (root.working) Qt.callLater(() => scroller.contentY = Math.max(0, scroller.contentHeight - scroller.height))
        }
    }

    ThemedDialog {
        id: discardDialog
        title: qsTr("Start a new project?")
        acceptText: qsTr("Discard and continue")
        acceptVariant: "destructive"
        preferredWidth: Theme.dialogWidthSm
        acceptOnReturn: false
        onAccepted: form.go()
        contentItem: ThemedLabel {
            width: parent ? parent.width : Theme.dialogWidthSm
            wrapMode: Text.WordWrap
            size: "sm"
            text: qsTr("Claude builds in a new project, and this one has unsaved changes. Save it first if you want to keep them.")
        }
    }

    ThemedDialog {
        id: removeDialog
        title: qsTr("Remove “%1”?").arg(root.pendingRemoval)
        acceptText: qsTr("Remove")
        acceptVariant: "destructive"
        preferredWidth: Theme.dialogWidthSm
        acceptOnReturn: false
        onAccepted: ClaudeAgent.removeSkill(root.pendingRemoval)
        contentItem: ThemedLabel {
            width: parent ? parent.width : Theme.dialogWidthSm
            wrapMode: Text.WordWrap
            size: "sm"
            text: qsTr("It moves to the .trash folder inside your skills folder, so you can get it back from there.")
        }
    }

    // --- pieces ---------------------------------------------------------------------------------------

    component FieldLabel: Text {
        color: Theme.foreground
        font.family: Theme.fontFamily
        font.pixelSize: Theme.fontSizeXs
        font.weight: Font.Medium
    }

    component ModelBox: ThemedComboBox {
        property string initial: ""
        model: ClaudeAgent.models
        textRole: "name"
        valueRole: "id"
        tooltip: currentIndex >= 0 && ClaudeAgent.models[currentIndex] ? ClaudeAgent.models[currentIndex].description : ""
        // Inline components can't see the file's ids, so no root.* helpers in here.
        function pick() {
            let i = -1
            for (let k = 0; k < ClaudeAgent.models.length; ++k)
                if (ClaudeAgent.models[k].id === initial) { i = k; break }
            currentIndex = i >= 0 ? i : 0
        }
        onInitialChanged: pick()
        onModelChanged: pick()
        Component.onCompleted: pick()
    }

    component EffortBox: ThemedComboBox {
        property string initial: ""
        model: ClaudeAgent.efforts
        function pick() {
            const i = ClaudeAgent.efforts.indexOf(initial)
            currentIndex = i >= 0 ? i : Math.max(0, ClaudeAgent.efforts.indexOf("high"))
        }
        onInitialChanged: pick()
        onModelChanged: pick()
        Component.onCompleted: pick()
    }

    component SceneCard: Rectangle {
        // The panel (inline components can't see the file's ids).
        property var panel
        id: card
        property int sceneIndex: 0
        readonly property var scene: panel.draftRev >= 0 && panel.draft.scenes ? panel.draft.scenes[sceneIndex] : ({})
        readonly property real startSec: {
            let t = 0
            for (let i = 0; i < sceneIndex && panel.draft.scenes; ++i) t += Number(panel.draft.scenes[i].durationSec) || 0
            return t
        }
        height: cardCol.implicitHeight + 2 * Theme.spacingSm
        radius: Theme.radiusMd
        color: Theme.panelSecondaryBg
        border.color: Theme.panelSecondaryBorder
        border.width: Theme.borderWidth

        Column {
            id: cardCol
            x: Theme.spacingSm
            y: Theme.spacingSm
            width: parent.width - 2 * Theme.spacingSm
            spacing: Theme.spacingXs

            Row {
                width: parent.width
                spacing: Theme.spacingXs
                Text {
                    anchors.verticalCenter: parent.verticalCenter
                    color: Theme.mutedForeground
                    font.family: Theme.monoFontFamily
                    font.pixelSize: Theme.fontSizeXs
                    text: (card.scene.id || "") + "  " + panel.fmtTime(card.startSec)
                }
                ThemedTextField {
                    width: parent.width - x - durField.width - secLabel.width - removeBtn.width - 3 * parent.spacing
                    text: card.scene.title || ""
                    onEditingFinished: panel.draft.scenes[card.sceneIndex].title = text
                }
                ThemedTextField {
                    id: durField
                    width: 52
                    horizontalAlignment: Text.AlignRight
                    validator: DoubleValidator { bottom: 0.5; top: 600; decimals: 1 }
                    text: card.scene.durationSec !== undefined ? String(card.scene.durationSec) : ""
                    onEditingFinished: {
                        const v = Number(text)
                        if (v > 0) { panel.draft.scenes[card.sceneIndex].durationSec = v; panel.touch() }
                    }
                }
                Text {
                    id: secLabel
                    anchors.verticalCenter: parent.verticalCenter
                    color: Theme.mutedForeground
                    font.family: Theme.fontFamily
                    font.pixelSize: Theme.fontSizeXs
                    text: qsTr("s")
                }
                IconButton {
                    id: removeBtn
                    anchors.verticalCenter: parent.verticalCenter
                    glyph: Theme.icons.trash
                    tooltip: qsTr("Remove this scene")
                    enabled: !!panel.draft.scenes && panel.draft.scenes.length > 1
                    onClicked: { panel.draft.scenes.splice(card.sceneIndex, 1); panel.touch() }
                }
            }

            SceneField {
                label: qsTr("Narration")
                visible: panel.draft.voiceover !== "none" || (card.scene.narration || "").length > 0
                value: card.scene.narration || ""
                onCommitted: (v) => panel.draft.scenes[card.sceneIndex].narration = v
            }
            SceneField {
                label: qsTr("On screen (one per line)")
                value: (card.scene.onScreenText || []).join("\n")
                onCommitted: (v) => panel.draft.scenes[card.sceneIndex].onScreenText = v.split("\n").map(s => s.trim()).filter(s => s.length > 0)
            }
            SceneField {
                label: qsTr("Visuals")
                muted: true
                value: card.scene.visuals || ""
                onCommitted: (v) => panel.draft.scenes[card.sceneIndex].visuals = v
            }
            Text {
                width: parent.width
                visible: !!card.scene.sourceRefs && card.scene.sourceRefs.length > 0
                elide: Text.ElideMiddle
                color: Theme.mutedForeground
                font.family: Theme.monoFontFamily
                font.pixelSize: Theme.fontSizeTiny
                text: card.scene.sourceRefs ? "↳ " + card.scene.sourceRefs.join(", ") : ""
            }
        }
    }

    // One skill in the manager. Built-in skills are customized (copied to your folder, where the
    // copy replaces them); your own are edited and removed.
    component SkillRow: Rectangle {
        id: sr
        property var skill: ({})
        property var panel
        readonly property bool mine: skill.origin === "user"
        height: srCol.implicitHeight + 2 * Theme.spacingSm
        radius: Theme.radiusMd
        color: Theme.panelSecondaryBg
        border.color: Theme.panelSecondaryBorder
        border.width: Theme.borderWidth
        opacity: skill.enabled === false ? 0.6 : 1

        Column {
            id: srCol
            x: Theme.spacingSm
            y: Theme.spacingSm
            width: parent.width - 2 * Theme.spacingSm
            spacing: Theme.spacingXs

            Item {
                width: parent.width
                height: Math.max(nameText.implicitHeight, enabledSwitch.implicitHeight)
                Text {
                    id: nameText
                    anchors.left: parent.left
                    anchors.verticalCenter: parent.verticalCenter
                    color: Theme.foreground
                    font.family: Theme.fontFamily
                    font.pixelSize: Theme.fontSizeSm
                    font.weight: Font.DemiBold
                    text: sr.skill.name || ""
                }
                Text {
                    anchors.left: nameText.right
                    anchors.leftMargin: Theme.spacingSm
                    anchors.verticalCenter: parent.verticalCenter
                    color: Theme.mutedForeground
                    font.family: Theme.fontFamily
                    font.pixelSize: Theme.fontSizeTiny
                    text: sr.skill.origin === "bundled" ? qsTr("built-in")
                          : (sr.mine ? (sr.skill.overridesBundled ? qsTr("yours · replaces built-in") : qsTr("yours")) : qsTr("extra"))
                }
                ThemedSwitch {
                    id: enabledSwitch
                    anchors.right: parent.right
                    anchors.verticalCenter: parent.verticalCenter
                    checked: sr.skill.enabled !== false
                    enabled: !ClaudeAgent.skillBusy
                    onToggled: ClaudeAgent.setSkillEnabled(sr.skill.name, checked)
                    tooltip: checked ? qsTr("Shown in the skill list") : qsTr("Hidden from the skill list")
                }
            }
            Text {
                width: parent.width
                wrapMode: Text.WordWrap
                maximumLineCount: 3
                elide: Text.ElideRight
                color: Theme.mutedForeground
                font.family: Theme.fontFamily
                font.pixelSize: Theme.fontSizeXs
                text: (sr.skill.description || "") + (sr.skill.sources && sr.skill.sources.length
                      ? "  ·  " + sr.skill.sources.join(", ") : "")
            }
            Flow {
                width: parent.width
                spacing: Theme.spacingXs
                IconButton {
                    visible: !sr.mine && sr.skill.origin === "bundled"
                    glyph: Theme.icons.pencil
                    text: qsTr("Customize")
                    tooltip: qsTr("Copy it to your skills folder and edit the copy; the original stays as it is")
                    enabled: !ClaudeAgent.skillBusy
                    onClicked: ClaudeAgent.customizeSkill(sr.skill.name)
                }
                IconButton {
                    visible: sr.skill.origin !== "bundled"
                    glyph: Theme.icons.pencil
                    text: qsTr("Edit")
                    tooltip: sr.skill.file || ""
                    onClicked: ClaudeAgent.editSkill(sr.skill.name)
                }
                IconButton {
                    glyph: Theme.icons.folder
                    text: qsTr("Folder")
                    onClicked: ClaudeAgent.openSkillFolder(sr.skill.name)
                }
                IconButton {
                    visible: sr.mine
                    glyph: Theme.icons.trash
                    text: qsTr("Remove")
                    tooltip: sr.skill.overridesBundled ? qsTr("Moves your copy to the trash folder; the built-in skill comes back")
                                                      : qsTr("Moves it to the trash folder in your skills folder")
                    enabled: !ClaudeAgent.skillBusy
                    onClicked: {
                        sr.panel.pendingRemoval = sr.skill.name
                        sr.panel.openRemoveDialog()
                    }
                }
            }
        }
    }

    component SceneField: Column {
        id: sf
        property string label: ""
        property string value: ""
        property bool muted: false
        signal committed(string value)
        width: parent ? parent.width : 0
        spacing: 2
        Text {
            color: Theme.mutedForeground
            font.family: Theme.fontFamily
            font.pixelSize: Theme.fontSizeTiny
            text: sf.label
        }
        ThemedTextArea {
            width: parent.width
            wrapMode: TextEdit.Wrap
            font.pixelSize: Theme.fontSizeXs
            color: sf.muted ? Theme.mutedForeground : Theme.foreground
            text: sf.value
            onEditingFinished: if (text !== sf.value) sf.committed(text)
        }
    }

    component ActivityRow: Item {
        id: row
        required property var modelData
        readonly property bool isTool: modelData.kind === "tool"
        readonly property bool bad: modelData.kind === "error" || modelData.kind === "denied" || (isTool && !modelData.pending && !modelData.ok)
        height: rowText.implicitHeight + 6

        Rectangle {
            id: mark
            x: 2
            y: 7
            width: 6; height: 6; radius: 3
            color: row.modelData.pending ? Theme.accent
                   : (row.bad ? Theme.destructive
                      : (row.isTool ? Theme.constructive : (row.modelData.kind === "text" ? Theme.foreground : Theme.mutedForeground)))
        }
        Text {
            id: rowText
            x: 16
            y: 2
            width: row.width - x
            wrapMode: Text.WordWrap
            maximumLineCount: row.isTool ? 2 : 12
            elide: Text.ElideRight
            color: row.bad ? Theme.destructive : (row.modelData.kind === "text" ? Theme.foreground : Theme.mutedForeground)
            font.family: row.isTool ? Theme.monoFontFamily : Theme.fontFamily
            font.pixelSize: Theme.fontSizeXs
            text: row.modelData.detail && row.modelData.detail.length > 0
                  ? row.modelData.text + "  " + row.modelData.detail : row.modelData.text
        }
    }
}
