using System;
using System.Linq;
using System.Windows.Forms;

namespace Mana.NativeLauncher;

// #1121: the Terminal tool's "My shell" tab -- my own shells (PowerShell by
// default, cmd too), each in its own tab, started in the repo folder. They
// run inside the launcher (PseudoConsole): Mana has no way to read them or
// type into them. "Send to Mana" is mine to click: it shares the selected
// text as a chat message, framed as outside text. Closing a tab ends that
// shell's whole process tree.
internal sealed class MyShellPanel : Panel
{
    internal static readonly (string Label, string CommandLine)[] Shells =
    [
        ("PowerShell", "powershell.exe -NoLogo"),
        ("cmd", "cmd.exe"),
    ];

    // The frame label "Send to Mana" uses; the chat shows those as a card.
    internal const string SharedSource = "my terminal";

    private readonly string workingDirectory;
    private readonly Action<string>? sendToMana;
    private readonly TabControl sessions = new() { Dock = DockStyle.Fill };
    private readonly Button closeButton = new() { Text = "Close", AutoSize = true, AccessibleName = "Close this shell" };
    private readonly Button sendButton = new() { Text = "Send to Mana", AutoSize = true, AccessibleName = "Send the selected text to Mana" };
    private readonly Label errorLabel = new() { Dock = DockStyle.Top, AutoSize = false, Height = 36, ForeColor = DarkTheme.Muted, Visible = false };

    private sealed record Session(PseudoConsole Console, TerminalView View);

    public MyShellPanel(string workingDirectory, Action<string>? sendToMana)
    {
        this.workingDirectory = workingDirectory;
        this.sendToMana = sendToMana;
        BackColor = DarkTheme.Panel2;

        var toolbar = new FlowLayoutPanel { Dock = DockStyle.Top, AutoSize = true, WrapContents = true, Padding = new Padding(0, 0, 0, 4) };
        foreach (var (label, commandLine) in Shells)
        {
            var button = new Button { Text = $"+ {label}", AutoSize = true, AccessibleName = $"New {label} shell" };
            DarkTheme.ApplyButton(button);
            button.Click += (_, _) => Open(label, commandLine);
            toolbar.Controls.Add(button);
        }
        DarkTheme.ApplyButton(closeButton);
        DarkTheme.ApplyButton(sendButton);
        closeButton.Click += (_, _) => Close(sessions.SelectedTab);
        sendButton.Click += (_, _) => SendSelection();
        sendButton.Visible = sendToMana is not null;
        toolbar.Controls.Add(closeButton);
        toolbar.Controls.Add(sendButton);
        sessions.SelectedIndexChanged += (_, _) => UpdateButtons();

        Controls.Add(sessions);
        Controls.Add(errorLabel);
        Controls.Add(toolbar);

        // The first shell opens the first time the tab is on screen.
        VisibleChanged += (_, _) =>
        {
            if (Visible && sessions.TabCount == 0 && !errorLabel.Visible)
            {
                Open(Shells[0].Label, Shells[0].CommandLine);
            }
        };
        UpdateButtons();
    }

    private Session? Current => sessions.SelectedTab?.Tag as Session;

    internal void Open(string label, string commandLine)
    {
        var screen = new VtScreen(80, 24);
        var view = new TerminalView(screen) { Dock = DockStyle.Fill };
        var page = new TabPage(label);
        page.Controls.Add(view);
        PseudoConsole console;
        try
        {
            console = new PseudoConsole(commandLine, workingDirectory, screen.Columns, screen.Rows);
        }
        catch (Exception ex)
        {
            page.Dispose();
            errorLabel.Text = $"Couldn't start {label}: {ex.Message}";
            errorLabel.Visible = true;
            return;
        }
        errorLabel.Visible = false;
        page.Tag = new Session(console, view);
        // Output comes on the console's reader thread.
        console.Output += text => OnUi(() =>
        {
            screen.Feed(text);
            view.OutputArrived();
        });
        console.Exited += () => OnUi(() => Close(page));
        screen.Reply += console.Write;
        view.Input += console.Write;
        view.Resized += console.Resize;
        view.SelectionChanged += UpdateButtons;
        sessions.TabPages.Add(page);
        sessions.SelectedTab = page;
        view.Focus();
        UpdateButtons();
    }

    // Ends the shell and everything it started.
    private void Close(TabPage? page)
    {
        if (page?.Tag is not Session session)
        {
            return;
        }
        page.Tag = null;
        session.Console.Dispose();
        sessions.TabPages.Remove(page);
        page.Dispose();
        UpdateButtons();
    }

    private void SendSelection()
    {
        var text = Current?.View.SelectedText ?? "";
        if (text.Trim().Length == 0 || sendToMana is null)
        {
            return;
        }
        sendToMana(UntrustedText.Wrap(SharedSource, text));
        Current!.View.ClearSelection();
    }

    private void UpdateButtons()
    {
        closeButton.Enabled = Current is not null;
        sendButton.Enabled = Current?.View.HasSelection == true;
    }

    private void OnUi(Action action)
    {
        if (IsHandleCreated && !IsDisposed)
        {
            BeginInvoke(action);
        }
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            foreach (var page in sessions.TabPages.Cast<TabPage>().ToList())
            {
                Close(page);
            }
        }
        base.Dispose(disposing);
    }
}
