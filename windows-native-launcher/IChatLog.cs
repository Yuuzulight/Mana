namespace Mana.NativeLauncher;

// #521: lets VoiceLoop report a turn's user text and each reply sentence
// as it streams, without VoiceLoop itself depending on WinForms. A null
// IChatLog (no chat window constructed) is a normal, common case --
// every call site treats it as "nothing to report to", not an error.
internal interface IChatLog
{
    void AppendUserMessage(string text);

    // #679: a typed message with images attached (data URLs).
    void AppendUserMessage(string text, IReadOnlyList<string> images) => AppendUserMessage(text);
    void AppendReplySentence(string text);

    // #914: speaker is the character saying it (group mode has two), or
    // null for the current reply's.
    void AppendReplySentence(string text, string? speaker) => AppendReplySentence(text);

    // #652 part 6: Mana's reply is complete (not interrupted, not failed) --
    // the chat checks then whether the turn left any edits for approval.
    void ReplyFinished() { }

    // #619: the live partial transcript of what the user is saying right
    // now ("Hearing: ..."), or null once that segment has closed.
    void ShowHearing(string? text) { }
}
