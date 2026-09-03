namespace Mana.NativeLauncher;

// #521: lets VoiceLoop report a turn's user text and each reply sentence
// as it streams, without VoiceLoop itself depending on WinForms. A null
// IChatLog (no chat window constructed) is a normal, common case --
// every call site treats it as "nothing to report to", not an error.
internal interface IChatLog
{
    void AppendUserMessage(string text);
    void AppendReplySentence(string text);
}
