using System;
using System.Drawing;
using System.IO;
using System.Windows.Forms;

namespace Mana.NativeLauncher;

internal enum AvatarState
{
    Idle,
    Talking,
}

internal sealed class AvatarOverlayForm : Form
{
    private readonly PictureBox avatarImage = new();
    private readonly string idlePath;
    private readonly string talkingPath;

    public AvatarOverlayForm(string rootDirectory)
    {
        idlePath = Path.Combine(rootDirectory, "windows-launcher", "assets", "avatar", "idle.png");
        talkingPath = Path.Combine(rootDirectory, "windows-launcher", "assets", "avatar", "talking.png");

        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        TopMost = true;
        Width = ReadIntEnv("MANA_AVATAR_WIDTH", 234);
        Height = ReadIntEnv("MANA_AVATAR_HEIGHT", 288);
        BackColor = Color.Magenta;
        TransparencyKey = Color.Magenta;
        StartPosition = FormStartPosition.Manual;

        avatarImage.Dock = DockStyle.Fill;
        avatarImage.SizeMode = PictureBoxSizeMode.Zoom;
        avatarImage.BackColor = Color.Transparent;
        Controls.Add(avatarImage);

        SetState(AvatarState.Idle);
        PositionOverlay();
    }

    public void SetState(AvatarState state)
    {
        var nextPath = state == AvatarState.Talking ? talkingPath : idlePath;
        if (!File.Exists(nextPath))
        {
            return;
        }

        avatarImage.Image?.Dispose();
        avatarImage.Image = Image.FromFile(nextPath);
    }

    protected override CreateParams CreateParams
    {
        get
        {
            const int wsExTransparent = 0x20;
            const int wsExToolWindow = 0x80;
            const int wsExNoActivate = 0x08000000;
            var cp = base.CreateParams;
            cp.ExStyle |= wsExTransparent | wsExToolWindow | wsExNoActivate;
            return cp;
        }
    }

    protected override bool ShowWithoutActivation => true;

    private void PositionOverlay()
    {
        var workArea = Screen.PrimaryScreen?.WorkingArea ?? Screen.FromControl(this).WorkingArea;
        var left = ReadIntEnv("MANA_AVATAR_LEFT", 782);
        var bottom = ReadIntEnv("MANA_AVATAR_BOTTOM", 0);
        Left = workArea.Left + left;
        Top = workArea.Bottom - Height - bottom;
    }

    private static int ReadIntEnv(string name, int fallback)
    {
        return int.TryParse(Environment.GetEnvironmentVariable(name), out var value)
            ? value
            : fallback;
    }
}
