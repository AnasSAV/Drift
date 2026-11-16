import QtQuick
import Drift

// drift --preview=ClaudePanel: the panel at a typical dock size, against the real ClaudeAgent
// (it finds agent/ next to the build and reads skills, models and login on load). The shot waits
// for that answer, so it shows the form rather than "Checking Claude…".
Item {
    implicitWidth: 400
    implicitHeight: 820

    property bool previewReady: !ClaudeAgent.loading && (ClaudeAgent.ready || ClaudeAgent.setupError.length > 0)

    ClaudePanel {
        anchors.fill: parent
    }
}
