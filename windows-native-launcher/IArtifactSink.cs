namespace Mana.NativeLauncher;

// #528: lets VoiceLoop report each turn's full final reply text for
// artifact detection, without VoiceLoop itself depending on WinForms or
// knowing what an "artifact" even is. ChatView is the sink (#686): it
// re-renders the reply and gives any artifact an "Open" button. Null (no
// chat constructed) is the no-op case, same convention as #521's IChatLog.
internal interface IArtifactSink
{
    void ReportReply(string replyText);
}
