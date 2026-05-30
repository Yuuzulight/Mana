WSL2 + CUDA quick setup (Windows 11)

This document lists steps to enable GPU passthrough to WSL so your RTX 3070 Ti can be used by PyTorch / bitsandbytes.

1. Install WSL2 (if not already)
   - Open PowerShell as Administrator and run:
     wsl --install -d Ubuntu
   - Reboot if prompted. This will install WSL2 and Ubuntu (latest).

2. Update Windows NVIDIA driver (must support WSL)
   - Download and install the latest NVIDIA Game Ready or Studio driver from NVIDIA that includes WSL support.
   - Reboot.

3. Install CUDA toolkit inside WSL (optional, many Python wheels work without it)
   - In WSL (Ubuntu):
     sudo apt update && sudo apt upgrade -y
     sudo apt install -y build-essential
   - Follow NVIDIA's WSL CUDA repo instructions to install CUDA and the nvidia-container-toolkit if you plan to use containers.

4. Verify GPU visible inside WSL
   - In WSL run:
     nvidia-smi --query-gpu=name,memory.total --format=csv,noheader
   - You should see your GPU name and VRAM (e.g. NVIDIA GeForce RTX 3070 Ti).

5. Python and pip
   - Install python3 and pip in WSL (Ubuntu):
     sudo apt install -y python3 python3-venv python3-pip

Notes
- WSLg on Windows 11 supports audio forwarding which can be helpful. However in this scaffold the Electron app captures microphone in Windows and sends the audio to WSL over HTTP, which avoids most audio forwarding issues.
- If you get CUDA errors when importing PyTorch, ensure your pip-installed torch is the CUDA-enabled build compatible with your driver and the WSL CUDA toolkit. For most projects, installing the proper torch wheel from pytorch.org (Linux + CUDA) inside WSL is recommended.

