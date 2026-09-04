namespace Mana.NativeLauncher;

// #528: lets VoiceLoop report each turn's full final reply text for
// artifact detection, without VoiceLoop itself depending on WinForms or
// knowing what an "artifact" even is. Null (no artifact viewer
// constructed) is the common, no-op case, same convention as #521's
// IChatLog.
internal interface IArtifactSink
{
    void ReportReply(string replyText);
}
